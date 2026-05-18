import { randomUUID } from "crypto";
import {
    createServer as createH2cServer,
    createSecureServer as createH2sServer,
    Http2Server as NodeHttp2Server,
    Http2SecureServer as NodeHttp2SecureServer,
    ServerHttp2Stream,
    IncomingHttpHeaders,
    constants as H2C
} from "http2";
import { SecureServerOptions } from "http2";

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
 * Where to listen. Always TCP; HTTP/2 doesn't run over UDS or pipes in any portable way.
 */
export interface Http2ListenTarget {
    port: number;
    host?: string;
}

export interface Http2ServerOptions {
    /** TLS / SecureServerOptions. When provided, `http2.createSecureServer(tls)` is used and ALPN
     *  is set to `"h2"`. When absent the server runs h2c cleartext — only suitable for trusted
     *  internal networks, since most non-Node clients (browsers, curl by default) won't speak h2c.
     */
    tls?: SecureServerOptions;
    logger?: Logger;
}

/**
 * One HTTP/2 stream = one AbsTransport. The `:path` pseudo-header is the namespace label.
 * There is no separate `mode` option: HTTP/2's stream multiplexing IS the mux model. If you
 * want "one connection per namespace", just don't reuse client sessions (open a fresh session
 * per `open()` call, which the client class can be configured to do via `mode`).
 */
class Http2ServerStreamTransport extends AbsTransport {
    private readonly _id: string;
    private readonly _label: string;
    private readonly _stream: ServerHttp2Stream;
    private readonly _credential: unknown;
    private readonly _decoder: FrameDecoder;
    private readonly _logger: Logger;
    private _connected = true;
    private readonly _channel_listeners: Map<string, Set<TransportMessageListener>> = new Map();
    private readonly _lifecycle: Map<TransportLifecycleEvent, Set<(...a: any[]) => void>> = new Map();
    private readonly _pending_rpcs: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = new Map();
    private _next_ack = 1;
    /** Hello-gate: until the client sends a `hello` envelope on this stream we hold `msg` envelopes
     *  so credential is populated before user code observes them. */
    private _hello_received = false;
    private readonly _hello_queue: Envelope[] = [];

    /** One-shot callback fired the moment the first `hello` envelope arrives, so the server can
     *  defer `endpoint.accept(this)` until `credential` is populated. Without this, the wrapping
     *  `RemoteSerialServerSocket` runs its `_authenticate(...)` before the client hello has
     *  arrived and `auth_validator` is called with `credential === undefined`. */
    private _on_hello_ready: (() => void) | null;

    constructor(stream: ServerHttp2Stream, label: string, credential_default: unknown, logger: Logger, on_hello_ready: (() => void) | null = null) {
        super();
        this._id = randomUUID();
        this._label = label;
        this._stream = stream;
        this._credential = credential_default;
        this._logger = logger;
        this._on_hello_ready = on_hello_ready;
        this._decoder = new FrameDecoder(
            (env) => this._on_envelope(env),
            (err) => {
                this._logger.warn(`http2 stream ${this._label}: ${err.message}; closing`);
                this.close();
            }
        );
        stream.on("data", (chunk: Buffer) => this._decoder.push(chunk));
        stream.on("close", () => this._on_remote_close());
        stream.on("error", (err) => this._logger.debug(`http2 stream ${this._label} error: ${err.message}`));
        // F8: do NOT fire `connect` lifecycle here. Other transports (raw-tcp, raw-ws, mqtt,
        // grpc) only fire `connect` after the credential is known — either because the transport
        // isn't constructed until hello arrives (raw-tcp/raw-ws) or the credential is in the
        // protocol-level header (grpc metadata). HTTP/2 constructs the transport on stream open
        // but credential only arrives in the subsequent `hello` envelope, so firing `connect`
        // here would expose pre-hello state. The hello handler fires it instead.
    }

    get id(): string { return this._id; }
    get is_connected(): boolean { return this._connected; }
    get endpoint_label(): string { return this._label; }
    get credential(): unknown { return this._credential_runtime ?? this._credential; }

    /** Updated when the client's hello envelope arrives carrying auth. */
    private _credential_runtime: unknown = undefined;

    private _on_envelope(env: Envelope): void {
        if (env === null || typeof env !== "object" || typeof (env as any).k !== "string") return;
        if (env.k === "hello") {
            // D9: guard against a duplicate `hello` on the same stream. The first hello
            // populates credential + fires the deferred endpoint.accept; any subsequent hello
            // would otherwise silently overwrite `_credential_runtime` (minor security gap —
            // a misbehaving or hostile client could "upgrade" its credential mid-session).
            if (this._hello_received === true) {
                this._logger.warn(`http2 stream ${this._label}: duplicate hello envelope; ignoring`);
                return;
            }
            this._credential_runtime = env.auth;
            this._hello_received = true;
            // Fire one-shot accept callback so the namespace endpoint sees this transport only
            // after credential is populated — fixes the race where auth_validator ran with
            // credential=undefined.
            const accept_cb = this._on_hello_ready;
            this._on_hello_ready = null;
            if (accept_cb !== null) { try { accept_cb(); } catch { /* swallow */ } }
            // F8 + F13: fire `connect` lifecycle now (post-credential), via setImmediate so
            // direct subscribers attached through Promise.then / await also catch it (nextTick
            // would fire before microtasks). Note this also keeps the post-hello ordering from
            // F8 — `connect` still fires AFTER credential is populated.
            setImmediate((): void => this._fire_lifecycle("connect"));
            for (const queued of this._hello_queue) this._dispatch_msg(queued as Envelope & { k: "msg" });
            this._hello_queue.length = 0;
            return;
        }
        if (env.k === "msg") {
            if (this._hello_received === false) { this._hello_queue.push(env); return; }
            this._dispatch_msg(env);
            return;
        }
        if (env.k === "ack") { this._dispatch_ack(env); return; }
        if (env.k === "bye") { this.close(); return; }
    }

    private _dispatch_msg(env: Envelope & { k: "msg" }): void {
        const listeners = this._channel_listeners.get(env.ch);
        if (listeners === undefined || listeners.size === 0) return;
        const ack_id: number | undefined = typeof env.ack === "number" ? env.ack : undefined;
        const ack_cb: TransportAckCallback | undefined = ack_id !== undefined
            ? (r) => this._send_envelope({ k: "ack", ack: ack_id, r })
            : undefined;
        for (const l of listeners) { try { l(env.p, ack_cb); } catch { /* isolated */ } }
    }

    private _dispatch_ack(env: Envelope & { k: "ack" }): void {
        const p = this._pending_rpcs.get(env.ack);
        if (p === undefined) return;
        clearTimeout(p.timer);
        this._pending_rpcs.delete(env.ack);
        p.resolve(env.r);
    }

    private _send_envelope(env: Envelope): void {
        if (this._connected === false) return;
        try {
            const frame: Buffer = encode(env);
            this._stream.write(frame);
        } catch (e) {
            this._logger.warn(`http2 stream send failed: ${(e as Error).message}`);
        }
    }

    send(channel: string, payload?: unknown): void {
        if (this._connected === false) return;
        // No `ns` — stream itself is the namespace
        this._send_envelope({ k: "msg", ch: channel, p: payload });
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
            this._send_envelope({ k: "msg", ch: channel, p: payload, ack: ack_id });
        });
    }

    on(channel: string, listener: TransportMessageListener): void {
        let set = this._channel_listeners.get(channel);
        if (set === undefined) { set = new Set(); this._channel_listeners.set(channel, set); }
        set.add(listener);
    }
    once(channel: string, listener: TransportMessageListener): void {
        const w: TransportMessageListener = (p, a) => { this.off(channel, w); listener(p, a); };
        this.on(channel, w);
    }
    off(channel: string, listener?: TransportMessageListener): void {
        if (listener === undefined) { this._channel_listeners.delete(channel); return; }
        this._channel_listeners.get(channel)?.delete(listener);
    }
    on_lifecycle(e: TransportLifecycleEvent, l: (...a: any[]) => void): void {
        let s = this._lifecycle.get(e); if (s === undefined) { s = new Set(); this._lifecycle.set(e, s); } s.add(l);
    }
    off_lifecycle(e: TransportLifecycleEvent, l: (...a: any[]) => void): void { this._lifecycle.get(e)?.delete(l); }

    get_buffered_amount(): number | null {
        return this._stream.writableLength ?? 0;
    }

    close(): void {
        if (this._connected === false) return;
        try { this._stream.end(); } catch {}
        try { this._stream.close(H2C.NGHTTP2_NO_ERROR); } catch {}
        this._on_remote_close();
    }

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

class Http2Endpoint extends AbsTransportEndpoint {
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

export class Http2Server extends AbsTransportServer {
    private readonly _target: Http2ListenTarget;
    private readonly _opts: Http2ServerOptions;
    private readonly _logger: Logger;
    private _http: NodeHttp2Server | NodeHttp2SecureServer | null = null;
    private readonly _endpoints: Map<string, Http2Endpoint> = new Map();
    private readonly _streams: Set<Http2ServerStreamTransport> = new Set();
    private _listening = false;

    constructor(target: Http2ListenTarget, opts: Http2ServerOptions = {}) {
        super();
        this._target = target;
        this._opts = opts;
        this._logger = opts.logger ?? default_logger;
    }

    listen(_port?: number): void {
        if (this._listening === true) return;
        this._listening = true;
        if (this._opts.tls !== undefined) {
            this._http = createH2sServer({ ...this._opts.tls, allowHTTP1: false });
        } else {
            this._http = createH2cServer();
        }
        this._http.on("stream", (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
            this._on_stream(stream, headers);
        });
        this._http.on("error", (err) => this._logger.error(`http2 server error: ${err.message}`));
        this._http.listen(this._target.port, this._target.host);
    }

    private _on_stream(stream: ServerHttp2Stream, headers: IncomingHttpHeaders): void {
        const path: string | undefined = headers[":path"] as string | undefined;
        if (path === undefined) {
            stream.respond({ ":status": 400 }); stream.end("missing :path"); return;
        }
        const label: string = path; // accept :path as-is — caller registers with same path
        const endpoint: Http2Endpoint | null = this._find_endpoint(label);
        if (endpoint === null) {
            this._logger.warn(`http2: stream :path="${label}" matched no endpoint; closing`);
            stream.respond({ ":status": 404 }); stream.end(); return;
        }
        // Accept the stream as a long-lived bi-di carrier — content-type is opaque bytes.
        stream.respond({ ":status": 200, "content-type": "application/octet-stream" }, { waitForTrailers: false });
        // Defer endpoint.accept(...) until the client's first `hello` envelope arrives — at that
        // point the transport's credential getter returns the auth payload, and the wrapping
        // RemoteSerialServerSocket's _authenticate() sees the real credential instead of
        // undefined. (Raw TCP / Raw WS use the equivalent pattern: their transport isn't even
        // constructed until hello has been parsed.)
        let accept_fired = false;
        const transport: Http2ServerStreamTransport = new Http2ServerStreamTransport(stream, label, undefined, this._logger, (): void => {
            if (accept_fired === true) return;
            accept_fired = true;
            endpoint.accept(transport);
        });
        this._streams.add(transport);
        transport.on_lifecycle("disconnect", () => this._streams.delete(transport));
    }

    private _find_endpoint(label: string): Http2Endpoint | null {
        for (const ep of this._endpoints.values()) if (ep.matches(label)) return ep;
        return null;
    }

    of(label: string | RegExp): AbsTransportEndpoint {
        const key: string = typeof label === "string" ? label : label.toString();
        const existing = this._endpoints.get(key);
        if (existing !== undefined) return existing;
        const ep = new Http2Endpoint(label);
        this._endpoints.set(key, ep);
        return ep;
    }

    close(): void {
        for (const s of this._streams) { try { s.close(); } catch {} }
        this._streams.clear();
        this._endpoints.clear();
        if (this._http !== null) { try { this._http.close(); } catch {} this._http = null; }
        this._listening = false;
    }
}
