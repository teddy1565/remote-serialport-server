import { randomUUID } from "crypto";
import { PeerConnection, DataChannel } from "node-datachannel";

import {
    AbsTransport,
    AbsTransportEndpoint,
    AbsTransportServer,
    TransportAckCallback,
    TransportLifecycleEvent,
    TransportMessageListener
} from "../types/remote-serialport-types/src/transport";
import { Logger } from "../types/remote-serialport-types/src/logger";
import { WebRtcSignalingChannel, WebRtcSignalingMessage } from "../types/remote-serialport-types/src/webrtc";
import { default_logger } from "./logger";
import { Envelope, FrameDecoder, encode } from "./shared/envelope-codec";

/**
 * WebRTC DataChannel transport.
 *
 * **EXPERIMENTAL.** WebRTC needs out-of-band signaling (SDP + ICE candidate exchange) before the
 * P2P connection can come up — this transport accepts a {@link WebRtcSignalingChannel} adapter
 * for that exchange. In tests we hand it an in-process `EventEmitter`-backed signaling shim; in
 * production users typically run a small WebSocket signaling server.
 *
 * Each peer connection's `DataChannel(label)` maps to one {@link AbsTransport}, so multiple
 * namespaces over one peer just means opening multiple DataChannels.
 */

// Re-export the shared signaling types so existing `import { WebRtcSignalingChannel } from
// "node-serialport-server"` paths keep resolving without forcing consumers to touch the types
// submodule. The single source of truth lives in `remote-serialport-types/src/webrtc.ts`.
export { WebRtcSignalingChannel, WebRtcSignalingMessage };

export interface WebRtcServerOptions {
    signaling: WebRtcSignalingChannel;
    /** ICE servers as strings (e.g. `"stun:stun.l.google.com:19302"`, `"turn:user:pass@host:3478"`).
     *  node-datachannel does NOT accept the W3C `{urls,username,credential}` object form. Default
     *  `["stun:stun.l.google.com:19302"]`. */
    ice_servers?: string[];
    logger?: Logger;
}

class WebRtcServerTransport extends AbsTransport {
    private readonly _id: string;
    private readonly _label: string;
    private readonly _dc: DataChannel;
    private readonly _credential: unknown;
    private readonly _decoder: FrameDecoder;
    private readonly _logger: Logger;
    private _connected = true;
    private readonly _channel_listeners: Map<string, Set<TransportMessageListener>> = new Map();
    private readonly _lifecycle: Map<TransportLifecycleEvent, Set<(...a: any[]) => void>> = new Map();
    private readonly _pending_rpcs: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = new Map();
    private _next_ack = 1;

    constructor(label: string, dc: DataChannel, credential: unknown, logger: Logger) {
        super();
        this._id = randomUUID();
        this._label = label;
        this._dc = dc;
        this._credential = credential;
        this._logger = logger;
        this._decoder = new FrameDecoder(
            (env) => this._on_envelope(env),
            (err) => { this._logger.warn(`webrtc dc ${this._label}: ${err.message}; closing`); this.close(); }
        );
        dc.onMessage((data: string | Buffer | ArrayBuffer) => {
            let buf: Buffer;
            if (typeof data === "string") buf = Buffer.from(data, "utf8");
            else if (Buffer.isBuffer(data)) buf = data;
            else buf = Buffer.from(data as ArrayBuffer);
            this._decoder.push(buf);
        });
        dc.onClosed(() => this._on_remote_close());
        dc.onError((err: string) => this._logger.debug(`webrtc dc ${this._label} err: ${err}`));
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
        if (this._connected === false || this._dc.isOpen() === false) return;
        try {
            const frame: Buffer = encode(env);
            this._dc.sendMessageBinary(frame);
        } catch (e) {
            this._logger.warn(`webrtc dc send failed: ${(e as Error).message}`);
        }
    }

    send(channel: string, payload?: unknown): void { this._send_envelope({ k: "msg", ch: channel, p: payload }); }

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

    get_buffered_amount(): number | null {
        try { return this._dc.bufferedAmount(); } catch { return null; }
    }

    close(): void {
        if (this._connected === false) return;
        try { this._dc.close(); } catch {}
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

class WebRtcEndpoint extends AbsTransportEndpoint {
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

export class WebRtcServer extends AbsTransportServer {
    private readonly _opts: WebRtcServerOptions;
    private readonly _logger: Logger;
    private readonly _peers: Map<string, PeerConnection> = new Map();
    private readonly _endpoints: Map<string, WebRtcEndpoint> = new Map();
    private readonly _ice_servers: string[];
    private _listening = false;

    constructor(opts: WebRtcServerOptions) {
        super();
        this._opts = opts;
        this._logger = opts.logger ?? default_logger;
        this._ice_servers = opts.ice_servers ?? ["stun:stun.l.google.com:19302"];
    }

    listen(_port?: number): void {
        if (this._listening === true) return;
        this._listening = true;
        this._opts.signaling.on_message((msg: WebRtcSignalingMessage) => this._on_signaling(msg));
    }

    private _on_signaling(msg: WebRtcSignalingMessage): void {
        if (msg.kind === "offer") {
            const peer = this._get_or_make_peer(msg.peer_id);
            peer.onDataChannel((dc: DataChannel) => this._on_data_channel(msg.peer_id, dc));
            peer.setRemoteDescription(msg.sdp!, "offer");
            return;
        }
        if (msg.kind === "candidate") {
            const peer = this._peers.get(msg.peer_id);
            if (peer === undefined) return;
            try { peer.addRemoteCandidate(msg.candidate ?? "", msg.mid ?? ""); } catch (e) { this._logger.debug(`webrtc addRemoteCandidate: ${(e as Error).message}`); }
            return;
        }
        // `answer` is server→client only; we shouldn't be receiving one.
    }

    private _get_or_make_peer(peer_id: string): PeerConnection {
        const existing = this._peers.get(peer_id);
        if (existing !== undefined) return existing;
        const peer = new PeerConnection(peer_id, { iceServers: this._ice_servers });
        this._peers.set(peer_id, peer);
        peer.onLocalDescription((sdp: string, sdp_type: string) => {
            this._opts.signaling.send({ kind: sdp_type as "offer" | "answer", peer_id, sdp, sdp_type: sdp_type as any });
        });
        peer.onLocalCandidate((candidate: string, mid: string) => {
            this._opts.signaling.send({ kind: "candidate", peer_id, candidate, mid });
        });
        // D8: prune the peer from `_peers` and release its native handles (DTLS/ICE/SCTP) on
        // terminal states. `disconnected` is transient (ICE can recover) so we keep it; only
        // `failed` and `closed` indicate the peer is permanently done.
        try {
            (peer as unknown as { onStateChange: (cb: (state: string) => void) => void }).onStateChange((state: string): void => {
                if (state === "failed" || state === "closed") {
                    if (this._peers.get(peer_id) === peer) {
                        this._peers.delete(peer_id);
                    }
                    try { peer.close(); } catch { /* already closed */ }
                }
            });
        } catch { /* older node-datachannel without onStateChange — no-op */ }
        return peer;
    }

    private _on_data_channel(peer_id: string, dc: DataChannel): void {
        const label: string = dc.getLabel();
        const endpoint: WebRtcEndpoint | null = this._find_endpoint(label);
        if (endpoint === null) {
            this._logger.warn(`webrtc: DataChannel for unregistered endpoint "${label}"; closing`);
            try { dc.close(); } catch {}
            return;
        }
        // We don't have credential here — WebRTC doesn't carry app-level auth out of the box.
        // Apps that need credentials should put them in the DataChannel label or send a hello envelope first.
        dc.onOpen(() => {
            const transport = new WebRtcServerTransport(label, dc, undefined, this._logger);
            endpoint.accept(transport);
        });
    }

    private _find_endpoint(label: string): WebRtcEndpoint | null {
        for (const ep of this._endpoints.values()) if (ep.matches(label)) return ep;
        return null;
    }

    of(label: string | RegExp): AbsTransportEndpoint {
        const key: string = typeof label === "string" ? label : label.toString();
        const existing = this._endpoints.get(key);
        if (existing !== undefined) return existing;
        const ep = new WebRtcEndpoint(label);
        this._endpoints.set(key, ep);
        return ep;
    }

    close(): void {
        for (const peer of this._peers.values()) { try { peer.close(); } catch {} }
        this._peers.clear();
        this._endpoints.clear();
        this._listening = false;
    }
}
