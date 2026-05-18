import { randomUUID } from "crypto";
import { createServer as createHttpServer, Server as HttpServer } from "http";
import { createServer as createHttpsServer, Server as HttpsServer } from "https";
import { TlsOptions } from "tls";
import { WebSocket, WebSocketServer } from "ws";

import {
    AbsTransport,
    AbsTransportEndpoint,
    AbsTransportServer,
    TransportAckCallback,
    TransportLifecycleEvent,
    TransportMessageListener
} from "../types/remote-serialport-types/src/transport";
import { Logger } from "../types/remote-serialport-types/src/logger";
import { default_logger } from "./logger";
import { Envelope, FrameDecoder, encode } from "./shared/envelope-codec";

/**
 * Where to listen. `port` (with optional `host`) for `ws://` / `wss://`. The transport doesn't
 * support UDS / Named Pipe (WebSocket negotiates over HTTP which assumes a TCP-like socket).
 */
export interface RawWebSocketListenTarget {
    port: number;
    host?: string;
    /** HTTP path the upgrade handshake will be accepted on (default `"/"`). */
    path?: string;
}

export interface RawWebSocketServerOptions {
    /** `"single-namespace"` (1 ws = 1 transport) or `"mux"` (default, 1 ws = N transports). */
    mode?: "single-namespace" | "mux";
    /** TLS options. When provided, the underlying HTTP server is upgraded to HTTPS and the
     *  WebSocket endpoint becomes `wss://`. */
    tls?: TlsOptions;
    logger?: Logger;
}

/* ============================================================================
 * Per-connection multiplexer state.
 * ========================================================================== */

class WsConnectionMux {
    private readonly _ws: WebSocket;
    private readonly _decoder: FrameDecoder;
    private readonly _mode: "single-namespace" | "mux";
    private readonly _logger: Logger;
    private readonly _on_first_hello: (label: string, auth: unknown) => RawWebSocketServerTransport | null;
    private readonly _transports: Map<string, RawWebSocketServerTransport> = new Map();
    private _single_label: string | null = null;
    private _alive = true;

    constructor(
        ws: WebSocket,
        mode: "single-namespace" | "mux",
        logger: Logger,
        on_first_hello: (label: string, auth: unknown) => RawWebSocketServerTransport | null
    ) {
        this._ws = ws;
        this._mode = mode;
        this._logger = logger;
        this._on_first_hello = on_first_hello;
        this._decoder = new FrameDecoder(
            (env) => this._on_envelope(env),
            (err) => {
                this._logger.warn(`raw-ws server: ${err.message}; closing`);
                this.close();
            }
        );
        ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
            const buf: Buffer = Buffer.isBuffer(data)
                ? data
                : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
            this._decoder.push(buf);
        });
        ws.on("close", () => this._on_close());
        ws.on("error", (err) => this._logger.debug(`raw-ws server socket error: ${err.message}`));
    }

    private _on_envelope(env: Envelope): void {
        if (env === null || typeof env !== "object" || typeof (env as any).k !== "string") return;
        switch (env.k) {
            case "hello": {
                const ns: string = this._mode === "mux" ? (env.ns ?? env.label) : env.label;
                if (this._mode === "single-namespace") {
                    if (this._single_label !== null) { this._logger.warn(`raw-ws single-namespace got second hello; ignoring`); return; }
                    this._single_label = env.label;
                }
                if (this._transports.has(ns)) { this._logger.warn(`raw-ws duplicate hello ns=${ns}`); return; }
                const t: RawWebSocketServerTransport | null = this._on_first_hello(ns, env.auth);
                if (t !== null) this._transports.set(ns, t);
                return;
            }
            case "msg": {
                const ns: string | null = this._mode === "mux"
                    ? (typeof env.ns === "string" ? env.ns : null)
                    : this._single_label;
                if (ns === null) return;
                this._transports.get(ns)?._dispatch_incoming(env);
                return;
            }
            case "ack": {
                // D5: route by `ns` when present (mux mode). See raw-tcp-transport.ts for full context.
                if (this._mode === "mux" && typeof env.ns === "string") {
                    this._transports.get(env.ns)?._dispatch_ack(env);
                    return;
                }
                for (const t of this._transports.values()) t._dispatch_ack(env);
                return;
            }
            case "bye": {
                if (this._mode === "single-namespace") { this.close(); return; }
                if (typeof env.ns === "string") {
                    this._transports.get(env.ns)?._on_remote_close();
                    this._transports.delete(env.ns);
                }
                return;
            }
        }
    }

    send_envelope(env: Envelope): void {
        if (this._alive === false || this._ws.readyState !== WebSocket.OPEN) return;
        try {
            const frame: Buffer = encode(env);
            this._ws.send(frame, { binary: true });
        } catch (e) {
            this._logger.warn(`raw-ws server send failed: ${(e as Error).message}`);
        }
    }

    get_buffered_amount(): number {
        return this._ws.bufferedAmount;
    }

    get mode(): "single-namespace" | "mux" { return this._mode; }

    private _on_close(): void {
        if (this._alive === false) return;
        this._alive = false;
        for (const t of this._transports.values()) t._on_remote_close();
        this._transports.clear();
    }

    close(): void {
        if (this._alive === false) return;
        try { this._ws.close(); } catch { /* ignore */ }
        try { this._ws.terminate(); } catch { /* ignore */ }
    }
}

/* ============================================================================
 * Per-namespace transport (server side).
 * ========================================================================== */

class RawWebSocketServerTransport extends AbsTransport {
    private readonly _id: string;
    private readonly _label: string;
    private readonly _mux: WsConnectionMux;
    private readonly _credential: unknown;
    private _connected = true;
    private readonly _channel_listeners: Map<string, Set<TransportMessageListener>> = new Map();
    private readonly _lifecycle: Map<TransportLifecycleEvent, Set<(...a: any[]) => void>> = new Map();
    private readonly _pending_rpcs: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = new Map();
    private _next_ack = 1;

    constructor(label: string, mux: WsConnectionMux, credential: unknown) {
        super();
        this._id = randomUUID();
        this._label = label;
        this._mux = mux;
        this._credential = credential;
        // F13: setImmediate (not process.nextTick) so Promise.then / await attach also catches.
        setImmediate(() => this._fire_lifecycle("connect"));
    }

    get id(): string { return this._id; }
    get is_connected(): boolean { return this._connected; }
    get endpoint_label(): string { return this._label; }
    get credential(): unknown { return this._credential; }

    send(channel: string, payload?: unknown): void {
        if (this._connected === false) return;
        const env: Envelope = this._mux.mode === "mux"
            ? { k: "msg", ns: this._label, ch: channel, p: payload }
            : { k: "msg", ch: channel, p: payload };
        this._mux.send_envelope(env);
    }

    send_rpc(channel: string, payload: unknown, timeout_ms: number): Promise<unknown> {
        return new Promise<unknown>((resolve, reject) => {
            if (this._connected === false) { reject(new Error("transport closed")); return; }
            const ack_id: number = this._next_ack++;
            const timer = setTimeout(() => {
                this._pending_rpcs.delete(ack_id);
                reject(new Error(`RPC "${channel}" timed out after ${timeout_ms}ms`));
            }, timeout_ms);
            this._pending_rpcs.set(ack_id, { resolve, reject, timer });
            const env: Envelope = this._mux.mode === "mux"
                ? { k: "msg", ns: this._label, ch: channel, p: payload, ack: ack_id }
                : { k: "msg", ch: channel, p: payload, ack: ack_id };
            this._mux.send_envelope(env);
        });
    }

    on(channel: string, listener: TransportMessageListener): void {
        let set = this._channel_listeners.get(channel);
        if (set === undefined) { set = new Set(); this._channel_listeners.set(channel, set); }
        set.add(listener);
    }
    once(channel: string, listener: TransportMessageListener): void {
        const wrapper: TransportMessageListener = (p, a) => { this.off(channel, wrapper); listener(p, a); };
        this.on(channel, wrapper);
    }
    off(channel: string, listener?: TransportMessageListener): void {
        if (listener === undefined) { this._channel_listeners.delete(channel); return; }
        this._channel_listeners.get(channel)?.delete(listener);
    }
    on_lifecycle(e: TransportLifecycleEvent, l: (...a: any[]) => void): void {
        let s = this._lifecycle.get(e); if (s === undefined) { s = new Set(); this._lifecycle.set(e, s); } s.add(l);
    }
    off_lifecycle(e: TransportLifecycleEvent, l: (...a: any[]) => void): void { this._lifecycle.get(e)?.delete(l); }

    get_buffered_amount(): number | null { return this._mux.get_buffered_amount(); }

    close(): void {
        if (this._connected === false) return;
        if (this._mux.mode === "mux") {
            this._mux.send_envelope({ k: "bye", ns: this._label });
            this._on_remote_close();
        } else {
            this._mux.close();
        }
    }

    /** @internal */
    _dispatch_incoming(env: Envelope & { k: "msg" }): void {
        const listeners = this._channel_listeners.get(env.ch);
        if (listeners === undefined || listeners.size === 0) return;
        const ack_id: number | undefined = typeof env.ack === "number" ? env.ack : undefined;
        const ack_cb: TransportAckCallback | undefined = ack_id !== undefined
            ? (r) => this._mux.send_envelope(this._mux.mode === "mux"
                  ? { k: "ack", ns: this._label, ack: ack_id, r }
                  : { k: "ack", ack: ack_id, r })
            : undefined;
        for (const l of listeners) { try { l(env.p, ack_cb); } catch { /* isolated */ } }
    }

    /** @internal */
    _dispatch_ack(env: Envelope & { k: "ack" }): void {
        const p = this._pending_rpcs.get(env.ack);
        if (p === undefined) return;
        clearTimeout(p.timer);
        this._pending_rpcs.delete(env.ack);
        p.resolve(env.r);
    }

    /** @internal */
    _on_remote_close(): void {
        if (this._connected === false) return;
        this._connected = false;
        for (const [, p] of this._pending_rpcs) { clearTimeout(p.timer); p.reject(new Error("transport closed")); }
        this._pending_rpcs.clear();
        this._fire_lifecycle("disconnect");
    }

    private _fire_lifecycle(event: TransportLifecycleEvent, ...args: any[]): void {
        const set = this._lifecycle.get(event);
        if (set === undefined) return;
        for (const l of set) { try { l(...args); } catch { /* */ } }
    }
}

/* ============================================================================
 * Endpoint (server-side, per label).
 * ========================================================================== */

class RawWebSocketEndpoint extends AbsTransportEndpoint {
    private readonly _label: string | RegExp;
    private _listener: ((t: AbsTransport) => void) | null = null;
    private readonly _pending: AbsTransport[] = [];
    private readonly _transports: Set<AbsTransport> = new Set();

    constructor(label: string | RegExp) { super(); this._label = label; }
    get label(): string | RegExp { return this._label; }

    on_connection(listener: (transport: AbsTransport) => void): void {
        this._listener = listener;
        while (this._pending.length > 0) this._fire(this._pending.shift()!);
    }

    accept(transport: AbsTransport): void {
        this._transports.add(transport);
        transport.on_lifecycle("disconnect", () => this._transports.delete(transport));
        if (this._listener === null) { this._pending.push(transport); return; }
        this._fire(transport);
    }

    private _fire(t: AbsTransport): void { try { this._listener!(t); } catch { /* swallow */ } }

    matches(label: string): boolean {
        return typeof this._label === "string" ? this._label === label : this._label.test(label);
    }

    close_all(): void {
        for (const t of this._transports) { try { (t as any).close?.(); } catch {} }
        this._transports.clear();
    }
}

/* ============================================================================
 * RawWebSocketServer — AbsTransportServer.
 * ========================================================================== */

export class RawWebSocketServer extends AbsTransportServer {
    private readonly _target: RawWebSocketListenTarget;
    private readonly _opts: RawWebSocketServerOptions;
    private readonly _mode: "single-namespace" | "mux";
    private readonly _logger: Logger;
    private _http: HttpServer | HttpsServer | null = null;
    private _wss: WebSocketServer | null = null;
    private readonly _endpoints: Map<string, RawWebSocketEndpoint> = new Map();
    private readonly _connections: Set<WsConnectionMux> = new Set();
    private _listening = false;

    constructor(target: RawWebSocketListenTarget, opts: RawWebSocketServerOptions = {}) {
        super();
        this._target = target;
        this._opts = opts;
        this._mode = opts.mode ?? "mux";
        this._logger = opts.logger ?? default_logger;
    }

    listen(_port?: number): void {
        if (this._listening === true) return;
        this._listening = true;
        this._http = this._opts.tls !== undefined
            ? createHttpsServer(this._opts.tls)
            : createHttpServer();
        this._wss = new WebSocketServer({ server: this._http, path: this._target.path });
        this._wss.on("connection", (ws: WebSocket) => this._on_ws(ws));
        this._http.listen(this._target.port, this._target.host);
        this._http.on("error", (err) => this._logger.error(`raw-ws server error: ${err.message}`));
    }

    private _on_ws(ws: WebSocket): void {
        const mux: WsConnectionMux = new WsConnectionMux(
            ws,
            this._mode,
            this._logger,
            (label: string, auth: unknown): RawWebSocketServerTransport | null => {
                const ep: RawWebSocketEndpoint | null = this._find_endpoint(label);
                if (ep === null) {
                    this._logger.warn(`raw-ws: hello for unregistered endpoint "${label}"; closing`);
                    return null;
                }
                const t = new RawWebSocketServerTransport(label, mux, auth);
                ep.accept(t);
                return t;
            }
        );
        this._connections.add(mux);
        // D7: prune connection on ws close so long-running servers don't accumulate dead muxes.
        ws.on("close", (): void => { this._connections.delete(mux); });
    }

    private _find_endpoint(label: string): RawWebSocketEndpoint | null {
        for (const ep of this._endpoints.values()) if (ep.matches(label)) return ep;
        return null;
    }

    of(label: string | RegExp): AbsTransportEndpoint {
        const key: string = typeof label === "string" ? label : label.toString();
        const existing = this._endpoints.get(key);
        if (existing !== undefined) return existing;
        const ep = new RawWebSocketEndpoint(label);
        this._endpoints.set(key, ep);
        return ep;
    }

    close(): void {
        for (const mux of this._connections) mux.close();
        this._connections.clear();
        this._endpoints.clear();
        if (this._wss !== null) { try { this._wss.close(); } catch {} this._wss = null; }
        if (this._http !== null) { try { this._http.close(); } catch {} this._http = null; }
        this._listening = false;
    }
}
