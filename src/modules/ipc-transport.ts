import { randomUUID } from "crypto";

import {
    AbsTransport,
    AbsTransportEndpoint,
    AbsTransportServer,
    TransportAckCallback,
    TransportLifecycleEvent,
    TransportMessageListener
} from "../types/remote-serialport-types/src/transport";

/**
 * Minimum surface this transport relies on. Both `worker_threads.MessagePort` and Electron's
 * `MessagePortMain` satisfy it (they share the W3C MessagePort shape plus Node `EventEmitter`
 * registration).
 */
export interface MessagePortLike {
    postMessage(value: unknown): void;
    on(event: "message", listener: (value: unknown) => void): unknown;
    on(event: "close", listener: () => void): unknown;
    off?(event: string, listener: (...args: any[]) => void): unknown;
    removeAllListeners?(event?: string): unknown;
    close?(): void;
    start?(): void;
}

interface IpcEnvelope {
    kind: "msg" | "ack" | "close" | "hello";
    channel?: string;
    payload?: unknown;
    /** Set on `msg` to request a reply, echoed back in the `ack` envelope. */
    ack_id?: number;
    /** Carried by `hello`: the client's auth credential (mirrors socket.io `handshake.auth`). */
    auth?: unknown;
}

interface PendingRpc {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

/**
 * AbsTransport over a Node `MessagePort` (worker_threads / Electron utility process).
 *
 * No reconnect. No wire-level backpressure indicator. Use `mux` mode if you need multiple ports
 * over one IPC pair (one process pair = one IPC connection = use mux).
 */
export class NodeIpcServerTransport extends AbsTransport {
    private readonly _port: MessagePortLike;
    private readonly _id: string;
    private readonly _label: string;
    private readonly _channel_listeners: Map<string, Set<TransportMessageListener>> = new Map();
    private readonly _lifecycle_listeners: Map<TransportLifecycleEvent, Set<(...args: any[]) => void>> = new Map();
    private readonly _pending_rpcs: Map<number, PendingRpc> = new Map();
    private readonly _on_message: (raw: unknown) => void;
    private readonly _on_close: () => void;
    private _is_connected = true;
    private _next_ack_id = 0;

    /** Set from the client's `hello` envelope; consumed by `credential` getter. */
    private _credential: unknown = undefined;
    /** Promise that resolves when a `hello` envelope arrives (used by the endpoint to gate on_connection). */
    private readonly _hello_promise: Promise<void>;
    private _hello_resolver: (() => void) | null = null;
    private _hello_received = false;

    constructor(port: MessagePortLike, label: string = "") {
        super();
        this._port = port;
        this._id = randomUUID();
        this._label = label;

        this._hello_promise = new Promise<void>((resolve): void => {
            this._hello_resolver = resolve;
        });

        this._on_message = (raw: unknown): void => this._handle_envelope(raw as IpcEnvelope);
        this._on_close = (): void => this._fire_disconnect();

        this._port.on("message", this._on_message);
        this._port.on("close", this._on_close);
        this._port.start?.();

        // Fire "connect" on next tick so subscribers added immediately after construction observe it.
        process.nextTick((): void => {
            if (this._is_connected === true) {
                this._fire_lifecycle("connect");
            }
        });
    }

    /** @internal Resolves once the client's `hello` envelope has been received. */
    wait_for_hello(): Promise<void> {
        return this._hello_promise;
    }

    /** Whether a hello envelope has arrived yet. */
    get hello_received(): boolean {
        return this._hello_received;
    }

    get id(): string {
        return this._id;
    }

    get is_connected(): boolean {
        return this._is_connected;
    }

    get endpoint_label(): string {
        return this._label;
    }

    get credential(): unknown {
        return this._credential;
    }

    send(channel: string, payload?: unknown): void {
        if (this._is_connected === false) {
            return;
        }
        const env: IpcEnvelope = arguments.length < 2 ? { kind: "msg", channel: channel } : { kind: "msg", channel: channel, payload: payload };
        this._port.postMessage(env);
    }

    send_rpc(channel: string, payload: unknown, timeout_ms: number): Promise<unknown> {
        if (this._is_connected === false) {
            return Promise.reject(new Error(`RPC "${channel}" rejected: transport closed`));
        }
        const ack_id: number = ++this._next_ack_id;
        return new Promise<unknown>((resolve, reject): void => {
            const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
                if (this._pending_rpcs.delete(ack_id) === true) {
                    reject(new Error(`RPC "${channel}" timed out after ${timeout_ms}ms`));
                }
            }, timeout_ms);
            this._pending_rpcs.set(ack_id, { resolve: resolve, reject: reject, timer: timer });
            this._port.postMessage({ kind: "msg", channel: channel, payload: payload, ack_id: ack_id });
        });
    }

    on(channel: string, listener: TransportMessageListener): void {
        let set: Set<TransportMessageListener> | undefined = this._channel_listeners.get(channel);
        if (set === undefined) {
            set = new Set();
            this._channel_listeners.set(channel, set);
        }
        set.add(listener);
    }

    once(channel: string, listener: TransportMessageListener): void {
        const wrapped: TransportMessageListener = (payload: unknown, ack?: TransportAckCallback): void => {
            this.off(channel, wrapped);
            listener(payload, ack);
        };
        this.on(channel, wrapped);
    }

    off(channel: string, listener?: TransportMessageListener): void {
        if (listener === undefined) {
            this._channel_listeners.delete(channel);
        } else {
            this._channel_listeners.get(channel)?.delete(listener);
        }
    }

    on_lifecycle(event: TransportLifecycleEvent, listener: (...args: any[]) => void): void {
        if (event === "reconnect") {
            // Node IPC has no reconnect semantics; never fires.
            return;
        }
        let set: Set<(...args: any[]) => void> | undefined = this._lifecycle_listeners.get(event);
        if (set === undefined) {
            set = new Set();
            this._lifecycle_listeners.set(event, set);
        }
        set.add(listener);
    }

    off_lifecycle(event: TransportLifecycleEvent, listener: (...args: any[]) => void): void {
        this._lifecycle_listeners.get(event)?.delete(listener);
    }

    /**
     * Node IPC has no wire buffer indicator. Returning `null` makes the wire-backpressure path skip
     * sampling — IPC writes are local memcpy, backpressure isn't meaningful here.
     */
    get_buffered_amount(): number | null {
        return null;
    }

    close(): void {
        if (this._is_connected === false) {
            return;
        }
        try {
            this._port.postMessage({ kind: "close" });
        } catch {
            // peer already gone
        }
        this._reject_all_pending(new Error("transport closed"));
        this._fire_disconnect();
        try {
            this._port.removeAllListeners?.();
            this._port.close?.();
        } catch {
            // ignore
        }
    }

    private _fire_disconnect(): void {
        if (this._is_connected === false) {
            return;
        }
        this._is_connected = false;
        this._reject_all_pending(new Error("transport closed"));
        this._fire_lifecycle("disconnect");
    }

    private _fire_lifecycle(event: TransportLifecycleEvent): void {
        const set: Set<(...args: any[]) => void> | undefined = this._lifecycle_listeners.get(event);
        if (set === undefined) {
            return;
        }
        for (const listener of Array.from(set)) {
            try {
                listener();
            } catch {
                // ignore
            }
        }
    }

    private _reject_all_pending(error: Error): void {
        for (const entry of this._pending_rpcs.values()) {
            clearTimeout(entry.timer);
            entry.reject(error);
        }
        this._pending_rpcs.clear();
    }

    private _handle_envelope(env: IpcEnvelope): void {
        if (env === null || typeof env !== "object") {
            return;
        }
        if (env.kind === "hello") {
            if (this._hello_received === true) {
                return; // ignore duplicate hello
            }
            this._hello_received = true;
            this._credential = env.auth;
            if (this._hello_resolver !== null) {
                this._hello_resolver();
                this._hello_resolver = null;
            }
            return;
        }
        if (env.kind === "ack") {
            if (typeof env.ack_id !== "number") {
                return;
            }
            const pending: PendingRpc | undefined = this._pending_rpcs.get(env.ack_id);
            if (pending === undefined) {
                return;
            }
            this._pending_rpcs.delete(env.ack_id);
            clearTimeout(pending.timer);
            pending.resolve(env.payload);
            return;
        }
        if (env.kind === "close") {
            this._fire_disconnect();
            return;
        }
        // msg
        if (typeof env.channel !== "string") {
            return;
        }
        const listeners: Set<TransportMessageListener> | undefined = this._channel_listeners.get(env.channel);
        if (listeners === undefined) {
            return;
        }
        const ack_id: number | undefined = env.ack_id;
        const ack: TransportAckCallback | undefined = typeof ack_id === "number" ? (response: unknown): void => {
            if (this._is_connected === false) {
                return;
            }
            this._port.postMessage({ kind: "ack", ack_id: ack_id, payload: response });
        } : undefined;
        for (const listener of Array.from(listeners)) {
            try {
                listener(env.payload, ack);
            } catch {
                // ignore listener errors
            }
        }
    }
}

/**
 * Single-transport endpoint: the IPC pair represents exactly one client connection, so this
 * endpoint synchronously fires its `on_connection` listener with the wrapped transport.
 */
export class NodeIpcServerEndpoint extends AbsTransportEndpoint {
    private readonly _label: string | RegExp;
    private readonly _transport: NodeIpcServerTransport;
    private _connection_listener: ((transport: AbsTransport) => void) | null = null;
    private _fired = false;

    constructor(label: string | RegExp, transport: NodeIpcServerTransport) {
        super();
        this._label = label;
        this._transport = transport;
    }

    get label(): string | RegExp {
        return this._label;
    }

    on_connection(listener: (transport: AbsTransport) => void): void {
        this._connection_listener = listener;
        if (this._fired === true) {
            return;
        }
        this._fired = true;
        // Wait for the client's `hello` envelope before exposing the transport: this guarantees
        // `transport.credential` is populated by the time the consumer code observes the new
        // connection, matching socket.io's `socket.handshake.auth` (which is already populated
        // when `connection` fires).
        this._transport.wait_for_hello().then((): void => {
            if (this._connection_listener !== null) {
                this._connection_listener(this._transport);
            }
        });
    }

    close_all(): void {
        this._transport.close();
    }
}

/**
 * AbsTransportServer over a single Node {@link MessagePortLike} pair. The IPC pair represents one
 * client connection; multiplexing many remote serial ports over it works via the existing
 * **mux mode** protocol (`server.mux(...)`).
 *
 * Calling `server.of(label)` on an IPC server returns an endpoint backed by the same single
 * connection — labels are not used for routing here. To serve multiple distinct labels over one
 * IPC pair you would need an envelope-level ns demux (not implemented yet); for now use mux mode.
 */
export class NodeIpcServer extends AbsTransportServer {
    private readonly _transport: NodeIpcServerTransport;
    private readonly _endpoints: Map<string, NodeIpcServerEndpoint> = new Map();

    constructor(port: MessagePortLike, label: string = "") {
        super();
        this._transport = new NodeIpcServerTransport(port, label);
    }

    /** The single underlying IPC transport. Useful for tests / advanced users. */
    get transport(): NodeIpcServerTransport {
        return this._transport;
    }

    listen(_port?: number): void {
        // No-op — IPC pairs are already connected when the MessagePort is passed in.
    }

    of(label: string | RegExp): AbsTransportEndpoint {
        const key: string = typeof label === "string" ? label : label.toString();
        const existing: NodeIpcServerEndpoint | undefined = this._endpoints.get(key);
        if (existing !== undefined) {
            return existing;
        }
        const endpoint: NodeIpcServerEndpoint = new NodeIpcServerEndpoint(label, this._transport);
        this._endpoints.set(key, endpoint);
        return endpoint;
    }

    close(): void {
        this._transport.close();
        this._endpoints.clear();
    }
}
