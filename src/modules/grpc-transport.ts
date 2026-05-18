import { randomUUID } from "crypto";
import * as path from "path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

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
 * gRPC transport. The `.proto` defines one bi-directional streaming RPC `Channel(stream Envelope)
 * returns (stream Envelope)`. Each call to `Channel` is one `AbsTransport`; the namespace label
 * and auth credential ride in the call metadata (gRPC headers).
 *
 * Metadata keys:
 *   `rsp-label` — namespace label (e.g. `/dev/ttyUSB0`). REQUIRED.
 *   `rsp-auth`  — optional auth credential as JSON-string; what the client put in `auth`.
 */

const PROTO_PATH = path.join(__dirname, "..", "..", "proto", "remote-serialport.proto");

interface ProtoEnvelope { frame: Buffer; }

let _proto_cache: any = null;
function _load_proto(): any {
    if (_proto_cache !== null) return _proto_cache;
    const def = protoLoader.loadSync(PROTO_PATH, {
        keepCase: true, longs: String, enums: String, defaults: true, oneofs: true
    });
    const root = grpc.loadPackageDefinition(def) as any;
    _proto_cache = root.remote_serialport.v2;
    return _proto_cache;
}

export interface GrpcListenTarget {
    /** TCP listen address. Defaults to `0.0.0.0:<port>` if just port given. */
    address: string; // e.g. "0.0.0.0:17996" or "[::]:17996"
}

export interface GrpcServerOptions {
    /** Server credentials. Pass an instance of `grpc.ServerCredentials.createSsl(...)` for TLS,
     *  or `grpc.ServerCredentials.createInsecure()` (the default) for cleartext. */
    credentials?: grpc.ServerCredentials;
    logger?: Logger;
}

class GrpcServerCallTransport extends AbsTransport {
    private readonly _id: string;
    private readonly _label: string;
    private readonly _call: grpc.ServerDuplexStream<ProtoEnvelope, ProtoEnvelope>;
    private readonly _credential: unknown;
    private readonly _decoder: FrameDecoder;
    private readonly _logger: Logger;
    private _connected = true;
    private readonly _channel_listeners: Map<string, Set<TransportMessageListener>> = new Map();
    private readonly _lifecycle: Map<TransportLifecycleEvent, Set<(...a: any[]) => void>> = new Map();
    private readonly _pending_rpcs: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = new Map();
    private _next_ack = 1;

    constructor(label: string, call: grpc.ServerDuplexStream<ProtoEnvelope, ProtoEnvelope>, credential: unknown, logger: Logger) {
        super();
        this._id = randomUUID();
        this._label = label;
        this._call = call;
        this._credential = credential;
        this._logger = logger;
        this._decoder = new FrameDecoder(
            (env) => this._on_envelope(env),
            (err) => { this._logger.warn(`grpc stream ${this._label}: ${err.message}; closing`); this.close(); }
        );
        call.on("data", (msg: ProtoEnvelope) => {
            if (msg !== null && msg !== undefined && Buffer.isBuffer(msg.frame)) {
                this._decoder.push(msg.frame);
            }
        });
        call.on("end", () => this._on_remote_close());
        call.on("close", () => this._on_remote_close());
        call.on("error", (err) => this._logger.debug(`grpc stream ${this._label} err: ${err.message}`));
        // F13: setImmediate (not process.nextTick) for sync + Promise.then + await symmetry.
        setImmediate(() => this._fire_lifecycle("connect"));
    }

    get id(): string { return this._id; }
    get is_connected(): boolean { return this._connected; }
    get endpoint_label(): string { return this._label; }
    get credential(): unknown { return this._credential; }

    private _on_envelope(env: Envelope): void {
        if (env === null || typeof env !== "object" || typeof (env as any).k !== "string") return;
        if (env.k === "msg") { this._dispatch_msg(env); return; }
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
            this._call.write({ frame });
        } catch (e) {
            this._logger.warn(`grpc server send failed: ${(e as Error).message}`);
        }
    }

    send(channel: string, payload?: unknown): void {
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
        let s = this._channel_listeners.get(channel);
        if (s === undefined) { s = new Set(); this._channel_listeners.set(channel, s); }
        s.add(listener);
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

    get_buffered_amount(): number | null { return null; }

    close(): void {
        if (this._connected === false) return;
        try { this._call.end(); } catch {}
        this._on_remote_close();
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

class GrpcEndpoint extends AbsTransportEndpoint {
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

export class GrpcServer extends AbsTransportServer {
    private readonly _target: GrpcListenTarget;
    private readonly _opts: GrpcServerOptions;
    private readonly _logger: Logger;
    private _server: grpc.Server | null = null;
    private readonly _endpoints: Map<string, GrpcEndpoint> = new Map();
    private readonly _calls: Set<GrpcServerCallTransport> = new Set();
    private _listening = false;

    constructor(target: GrpcListenTarget, opts: GrpcServerOptions = {}) {
        super();
        this._target = target;
        this._opts = opts;
        this._logger = opts.logger ?? default_logger;
    }

    listen(_port?: number): void {
        if (this._listening === true) return;
        this._listening = true;
        const proto: any = _load_proto();
        this._server = new grpc.Server();
        this._server.addService(proto.RemoteSerialport.service, {
            Channel: (call: grpc.ServerDuplexStream<ProtoEnvelope, ProtoEnvelope>) => this._on_call(call)
        });
        const creds: grpc.ServerCredentials = this._opts.credentials ?? grpc.ServerCredentials.createInsecure();
        this._server.bindAsync(this._target.address, creds, (err) => {
            if (err !== null && err !== undefined) this._logger.error(`grpc bind failed: ${err.message}`);
        });
    }

    private _on_call(call: grpc.ServerDuplexStream<ProtoEnvelope, ProtoEnvelope>): void {
        const metadata = call.metadata;
        const label_meta = metadata.get("rsp-label");
        if (label_meta.length === 0) {
            call.end();
            return;
        }
        const label: string = String(label_meta[0]);
        const auth_meta = metadata.get("rsp-auth");
        let auth: unknown = undefined;
        if (auth_meta.length > 0) {
            try { auth = JSON.parse(String(auth_meta[0])); } catch { auth = String(auth_meta[0]); }
        }
        const endpoint: GrpcEndpoint | null = this._find_endpoint(label);
        if (endpoint === null) {
            this._logger.warn(`grpc: hello for unregistered endpoint "${label}"; closing`);
            call.end();
            return;
        }
        const transport = new GrpcServerCallTransport(label, call, auth, this._logger);
        this._calls.add(transport);
        transport.on_lifecycle("disconnect", () => this._calls.delete(transport));
        endpoint.accept(transport);
    }

    private _find_endpoint(label: string): GrpcEndpoint | null {
        for (const ep of this._endpoints.values()) if (ep.matches(label)) return ep;
        return null;
    }

    of(label: string | RegExp): AbsTransportEndpoint {
        const key: string = typeof label === "string" ? label : label.toString();
        const existing = this._endpoints.get(key);
        if (existing !== undefined) return existing;
        const ep = new GrpcEndpoint(label);
        this._endpoints.set(key, ep);
        return ep;
    }

    close(): void {
        for (const t of this._calls) { try { t.close(); } catch {} }
        this._calls.clear();
        this._endpoints.clear();
        if (this._server !== null) { try { this._server.forceShutdown(); } catch {} this._server = null; }
        this._listening = false;
    }
}
