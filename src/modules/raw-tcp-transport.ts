import { randomUUID } from "crypto";
import { Server as NetServer, Socket, createServer as netCreateServer } from "net";
import { Server as TlsServer, createServer as tlsCreateServer, TLSSocket, TlsOptions } from "tls";
import { chmod } from "fs";

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
 * Where to listen. Either a TCP port (with optional bind host) **or** a UDS / Named Pipe path.
 * TCP form supports TLS; UDS / Named Pipe form does NOT (file permissions are the security
 * boundary on those).
 */
export type RawTcpListenTarget = { port: number; host?: string } | { path: string };

/**
 * Options for {@link RawTcpServer}. `mode` defaults to `"mux"` to match socket.io's
 * many-namespaces-per-connection idiom; switch to `"single-namespace"` for an IPC-like
 * one-connection-per-namespace model.
 */
export interface RawTcpServerOptions {
    /** `"single-namespace"`: 1 TCP connection = 1 transport, namespace bound by the client's
     *  hello envelope. `"mux"` (default): 1 TCP connection = many transports, namespace
     *  encoded per-envelope. */
    mode?: "single-namespace" | "mux";
    /** TLS options (`{ key, cert }` etc.). Only valid for TCP targets — ignored for UDS / Pipe. */
    tls?: TlsOptions;
    /** Enable TCP keepalive. Boolean shorthand uses 30s initial delay; pass `{ initial_delay_ms }`
     *  to customise. Default: enabled, 30s. */
    keep_alive?: boolean | { initial_delay_ms: number };
    /** Octal `chmod` to apply to a UDS path after `listen()` (no-op for TCP / Pipe). */
    permissions?: number;
    /** Inject a custom {@link Logger}. */
    logger?: Logger;
}

function _is_path_target(t: RawTcpListenTarget): t is { path: string } {
    return Object.prototype.hasOwnProperty.call(t, "path");
}

/* ============================================================================
 * Per-connection multiplexer state.
 *
 * In `mode: "mux"` one TCP connection hosts many transports keyed by `ns`. We hold this
 * state in the Mux object and inject a `send_envelope` closure into each transport so the
 * transport doesn't need to know the multiplexing detail.
 *
 * In `mode: "single-namespace"` there is exactly one transport per connection; we still go
 * through the same Mux machinery (with only one entry) so the codepath stays uniform.
 * ========================================================================== */

class ConnectionMux {
    private readonly _socket: Socket | TLSSocket;
    private readonly _decoder: FrameDecoder;
    private readonly _mode: "single-namespace" | "mux";
    private readonly _logger: Logger;
    private readonly _on_first_hello: (label: string, auth: unknown) => RawTcpServerTransport | null;
    /** ns → transport for this connection. In single-namespace mode there is at most one entry. */
    private readonly _transports: Map<string, RawTcpServerTransport> = new Map();
    private _single_label: string | null = null;
    private _alive = true;

    constructor(
        socket: Socket | TLSSocket,
        mode: "single-namespace" | "mux",
        logger: Logger,
        on_first_hello: (label: string, auth: unknown) => RawTcpServerTransport | null
    ) {
        this._socket = socket;
        this._mode = mode;
        this._logger = logger;
        this._on_first_hello = on_first_hello;
        this._decoder = new FrameDecoder(
            (env) => this._on_envelope(env),
            (err) => {
                this._logger.warn(`raw-tcp connection ${this._peer()}: ${err.message}; closing`);
                this.close();
            }
        );
        socket.on("data", (chunk: Buffer) => this._decoder.push(chunk));
        socket.on("close", () => this._on_close());
        socket.on("error", (err) => {
            this._logger.debug(`raw-tcp connection ${this._peer()} error: ${err.message}`);
            this._on_close();
        });
    }

    private _peer(): string {
        const s: any = this._socket;
        return `${s.remoteAddress ?? "?"}:${s.remotePort ?? "?"}`;
    }

    private _on_envelope(env: Envelope): void {
        if (env === null || typeof env !== "object" || typeof (env as any).k !== "string") {
            this._logger.warn(`raw-tcp: discarding malformed envelope`);
            return;
        }
        switch (env.k) {
            case "hello": {
                const ns: string = this._mode === "mux" ? (env.ns ?? env.label) : env.label;
                if (this._mode === "single-namespace") {
                    if (this._single_label !== null) {
                        this._logger.warn(`raw-tcp single-namespace got a second hello (label=${env.label}); ignoring`);
                        return;
                    }
                    this._single_label = env.label;
                }
                if (this._transports.has(ns)) {
                    this._logger.warn(`raw-tcp duplicate hello for ns=${ns}; ignoring`);
                    return;
                }
                const transport: RawTcpServerTransport | null = this._on_first_hello(ns, env.auth);
                if (transport !== null) {
                    this._transports.set(ns, transport);
                }
                return;
            }
            case "msg": {
                const ns: string | null = this._mode === "mux"
                    ? (typeof env.ns === "string" ? env.ns : null)
                    : this._single_label;
                if (ns === null) {
                    this._logger.warn(`raw-tcp msg with no ns route; dropping`);
                    return;
                }
                const transport: RawTcpServerTransport | undefined = this._transports.get(ns);
                if (transport === undefined) {
                    this._logger.warn(`raw-tcp msg for unknown ns=${ns}; dropping`);
                    return;
                }
                transport._dispatch_incoming(env);
                return;
            }
            case "ack": {
                // Route by `ns` when present (mux mode) — ack_id counters are per-transport so
                // two transports on the same mux can have a pending ack with the same id; the
                // pre-D5 broadcast loop resolved the wrong promise. Single-namespace mode and
                // legacy peers that omit `ns` fall back to dispatch on the sole transport.
                if (this._mode === "mux" && typeof env.ns === "string") {
                    const t: RawTcpServerTransport | undefined = this._transports.get(env.ns);
                    t?._dispatch_ack(env);
                    return;
                }
                for (const t of this._transports.values()) t._dispatch_ack(env);
                return;
            }
            case "bye": {
                if (this._mode === "single-namespace") {
                    this.close();
                    return;
                }
                if (typeof env.ns === "string") {
                    const t = this._transports.get(env.ns);
                    t?._on_remote_close();
                    this._transports.delete(env.ns);
                }
                return;
            }
        }
    }

    send_envelope(env: Envelope): void {
        if (this._alive === false) return;
        try {
            const frame: Buffer = encode(env);
            this._socket.write(frame);
        } catch (e) {
            this._logger.warn(`raw-tcp send failed: ${(e as Error).message}`);
        }
    }

    get_buffered_amount(): number {
        return (this._socket as Socket).writableLength ?? 0;
    }

    private _on_close(): void {
        if (this._alive === false) return;
        this._alive = false;
        for (const t of this._transports.values()) t._on_remote_close();
        this._transports.clear();
    }

    close(): void {
        if (this._alive === false) return;
        try { this._socket.end(); } catch { /* ignore */ }
        try { this._socket.destroy(); } catch { /* ignore */ }
    }

    get mode(): "single-namespace" | "mux" { return this._mode; }
}

/* ============================================================================
 * Per-namespace transport (server side).
 * ========================================================================== */

class RawTcpServerTransport extends AbsTransport {
    private readonly _id: string;
    private readonly _label: string;
    private readonly _mux: ConnectionMux;
    private readonly _credential: unknown;
    private _connected = true;
    private readonly _channel_listeners: Map<string, Set<TransportMessageListener>> = new Map();
    private readonly _lifecycle: Map<TransportLifecycleEvent, Set<(...a: any[]) => void>> = new Map();
    private readonly _pending_rpcs: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = new Map();
    private _next_ack = 1;

    constructor(label: string, mux: ConnectionMux, credential: unknown) {
        super();
        this._id = randomUUID();
        this._label = label;
        this._mux = mux;
        this._credential = credential;
        // F13: fire 'connect' via setImmediate (not process.nextTick) so subscribers attached
        // through Promise.then / await chains also observe it. nextTick fires BEFORE microtasks
        // (Promise continuations); setImmediate fires AFTER, so it works for sync + Promise +
        // await attach patterns uniformly. Negligible extra delay (one event-loop tick).
        setImmediate((): void => this._fire_lifecycle("connect"));
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
        return new Promise<unknown>((resolve, reject): void => {
            if (this._connected === false) { reject(new Error("transport closed")); return; }
            const ack_id: number = this._next_ack++;
            const timer = setTimeout((): void => {
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
        let set: Set<TransportMessageListener> | undefined = this._channel_listeners.get(channel);
        if (set === undefined) { set = new Set(); this._channel_listeners.set(channel, set); }
        set.add(listener);
    }

    once(channel: string, listener: TransportMessageListener): void {
        const wrapper: TransportMessageListener = (payload, ack): void => {
            this.off(channel, wrapper);
            listener(payload, ack);
        };
        this.on(channel, wrapper);
    }

    off(channel: string, listener?: TransportMessageListener): void {
        if (listener === undefined) { this._channel_listeners.delete(channel); return; }
        this._channel_listeners.get(channel)?.delete(listener);
    }

    on_lifecycle(event: TransportLifecycleEvent, listener: (...args: any[]) => void): void {
        let set = this._lifecycle.get(event);
        if (set === undefined) { set = new Set(); this._lifecycle.set(event, set); }
        set.add(listener);
    }

    off_lifecycle(event: TransportLifecycleEvent, listener: (...args: any[]) => void): void {
        this._lifecycle.get(event)?.delete(listener);
    }

    get_buffered_amount(): number | null {
        return this._mux.get_buffered_amount();
    }

    close(): void {
        if (this._connected === false) return;
        if (this._mux.mode === "mux") {
            // graceful per-namespace teardown signal
            this._mux.send_envelope({ k: "bye", ns: this._label });
            this._on_remote_close();
        } else {
            this._mux.close();
        }
    }

    /** @internal — invoked by ConnectionMux when a `msg` envelope arrives for this ns. */
    _dispatch_incoming(env: Envelope & { k: "msg" }): void {
        const listeners: Set<TransportMessageListener> | undefined = this._channel_listeners.get(env.ch);
        if (listeners === undefined || listeners.size === 0) return;
        const ack_id: number | undefined = typeof env.ack === "number" ? env.ack : undefined;
        const ack_cb: TransportAckCallback | undefined = ack_id !== undefined
            ? (response: unknown): void => {
                  // Tag ack with our `ns` in mux mode so the peer's ConnectionMux routes the
                  // ack back to the originating transport (per-transport ack id counters can
                  // collide otherwise — see D5).
                  const reply_env: Envelope = this._mux.mode === "mux"
                      ? { k: "ack", ns: this._label, ack: ack_id, r: response }
                      : { k: "ack", ack: ack_id, r: response };
                  this._mux.send_envelope(reply_env);
              }
            : undefined;
        // Each listener is isolated — a thrown listener must not stop the others on this channel
        // and must not bubble up to take down the TCP socket.
        for (const l of listeners) {
            try { l(env.p, ack_cb); }
            catch (e) { /* swallowed; library logger isn't reachable from here without coupling */ }
        }
    }

    /** @internal — invoked by ConnectionMux on inbound ack envelope. */
    _dispatch_ack(env: Envelope & { k: "ack" }): void {
        const p = this._pending_rpcs.get(env.ack);
        if (p === undefined) return;
        clearTimeout(p.timer);
        this._pending_rpcs.delete(env.ack);
        p.resolve(env.r);
    }

    /** @internal — invoked by ConnectionMux when the underlying socket / per-ns bye fires. */
    _on_remote_close(): void {
        if (this._connected === false) return;
        this._connected = false;
        for (const [, p] of this._pending_rpcs) {
            clearTimeout(p.timer);
            p.reject(new Error("transport closed"));
        }
        this._pending_rpcs.clear();
        this._fire_lifecycle("disconnect");
    }

    private _fire_lifecycle(event: TransportLifecycleEvent, ...args: any[]): void {
        const set = this._lifecycle.get(event);
        if (set === undefined) return;
        for (const l of set) {
            try { l(...args); } catch { /* swallow listener errors */ }
        }
    }
}

/* ============================================================================
 * Endpoint — server-side, one per label registered via `server.of(label)`.
 * ========================================================================== */

class RawTcpEndpoint extends AbsTransportEndpoint {
    private readonly _label: string | RegExp;
    private _listener: ((t: AbsTransport) => void) | null = null;
    private readonly _pending: AbsTransport[] = [];
    private readonly _transports: Set<AbsTransport> = new Set();

    constructor(label: string | RegExp) {
        super();
        this._label = label;
    }

    get label(): string | RegExp { return this._label; }

    on_connection(listener: (transport: AbsTransport) => void): void {
        this._listener = listener;
        while (this._pending.length > 0) {
            const t = this._pending.shift()!;
            this._fire(t);
        }
    }

    accept(transport: AbsTransport): void {
        this._transports.add(transport);
        transport.on_lifecycle("disconnect", (): void => { this._transports.delete(transport); });
        if (this._listener === null) {
            this._pending.push(transport);
            return;
        }
        this._fire(transport);
    }

    private _fire(t: AbsTransport): void {
        try { this._listener!(t); } catch (e) {
            // Don't let user-handler errors take down the endpoint dispatch loop.
            // (Mirrors socket.io's behaviour: errors in connection callbacks are swallowed.)
        }
    }

    matches(label: string): boolean {
        if (typeof this._label === "string") return this._label === label;
        return this._label.test(label);
    }

    close_all(): void {
        for (const t of this._transports) {
            try { (t as any).close?.(); } catch { /* ignore */ }
        }
        this._transports.clear();
    }
}

/* ============================================================================
 * RawTcpServer — top-level AbsTransportServer.
 * ========================================================================== */

export class RawTcpServer extends AbsTransportServer {
    private readonly _target: RawTcpListenTarget;
    private readonly _opts: RawTcpServerOptions;
    private readonly _mode: "single-namespace" | "mux";
    private readonly _logger: Logger;
    private _server: NetServer | TlsServer | null = null;
    private readonly _endpoints: Map<string, RawTcpEndpoint> = new Map();
    private readonly _connections: Set<ConnectionMux> = new Set();
    private _listening = false;

    constructor(target: RawTcpListenTarget, opts: RawTcpServerOptions = {}) {
        super();
        this._target = target;
        this._opts = opts;
        this._mode = opts.mode ?? "mux";
        this._logger = opts.logger ?? default_logger;
        if (_is_path_target(target) && opts.tls !== undefined) {
            this._logger.warn(
                "raw-tcp: `tls` option is ignored for UDS / Named Pipe targets " +
                "(file permissions are the only security boundary on those)"
            );
        }
    }

    listen(_port?: number): void {
        if (this._listening === true) return;
        this._listening = true;

        const use_tls: boolean = (this._opts.tls !== undefined) && !_is_path_target(this._target);
        if (use_tls === true) {
            this._server = tlsCreateServer(this._opts.tls!, (s) => this._on_connection(s));
        } else {
            this._server = netCreateServer((s) => this._on_connection(s));
        }

        if (_is_path_target(this._target)) {
            this._server.listen(this._target.path, () => this._after_listen());
        } else {
            this._server.listen(this._target.port, this._target.host, () => this._after_listen());
        }
        this._server.on("error", (err) => this._logger.error(`raw-tcp server error: ${err.message}`));
    }

    private _after_listen(): void {
        if (_is_path_target(this._target) && typeof this._opts.permissions === "number") {
            chmod(this._target.path, this._opts.permissions, (err) => {
                if (err !== null && err !== undefined) {
                    this._logger.warn(`raw-tcp: failed to chmod UDS path: ${err.message}`);
                }
            });
        }
    }

    private _on_connection(socket: Socket | TLSSocket): void {
        // Apply TCP keepalive (no-op on UDS / Pipe at OS level on most platforms but harmless).
        const ka = this._opts.keep_alive ?? true;
        if (ka !== false) {
            const delay: number = typeof ka === "object" ? ka.initial_delay_ms : 30_000;
            try { socket.setKeepAlive(true, delay); } catch { /* not applicable */ }
        }

        const mux: ConnectionMux = new ConnectionMux(
            socket,
            this._mode,
            this._logger,
            (label: string, auth: unknown): RawTcpServerTransport | null => {
                const endpoint: RawTcpEndpoint | null = this._find_endpoint(label);
                if (endpoint === null) {
                    this._logger.warn(`raw-tcp: hello for unregistered endpoint "${label}"; closing`);
                    return null;
                }
                const transport = new RawTcpServerTransport(label, mux, auth);
                endpoint.accept(transport);
                return transport;
            }
        );
        this._connections.add(mux);
        // D7: prune the connection from the parent server's tracking Set on socket close so
        // long-running servers with high churn don't accumulate dead ConnectionMux objects.
        socket.on("close", (): void => { this._connections.delete(mux); });
    }

    private _find_endpoint(label: string): RawTcpEndpoint | null {
        for (const ep of this._endpoints.values()) {
            if (ep.matches(label)) return ep;
        }
        return null;
    }

    of(label: string | RegExp): AbsTransportEndpoint {
        const key: string = typeof label === "string" ? label : label.toString();
        const existing: RawTcpEndpoint | undefined = this._endpoints.get(key);
        if (existing !== undefined) return existing;
        const endpoint: RawTcpEndpoint = new RawTcpEndpoint(label);
        this._endpoints.set(key, endpoint);
        return endpoint;
    }

    close(): void {
        for (const mux of this._connections) mux.close();
        this._connections.clear();
        this._endpoints.clear();
        if (this._server !== null) {
            try { this._server.close(); } catch { /* ignore */ }
            this._server = null;
        }
        this._listening = false;
    }
}
