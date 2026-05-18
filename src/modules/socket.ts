import EventEmitter from "events";
import { SerialPort } from "serialport";

import { AbsTransport, AbsTransportEndpoint } from "../types/remote-serialport-types/src/transport";

import {
    REMOTE_SERIALPORT_PROTOCOL_VERSION,
    RemoteSerialPortState,
    SerialPortPacket,
    SocketIONamespaceOnEvent,
    SocketServerSideEmitChannel_Handshake,
    SocketServerSideEmitChannel_State,
    SocketServerSideEmitChannel_Packet,
    SocketServerSideEmitChannel_Drain,
    SocketServerSideEmitChannel_Mux_State,
    SocketServerSideEmitChannel_Mux_Packet,
    SocketServerSideEmitChannel_Mux_Drain,
    SocketServerSideEmitPayload_Handshake,
    SocketServerSideEmitPayload_State,
    SocketServerSideEmitPayload_Mux_State,
    SocketServerSideEmitPayload_Mux_Packet,
    SocketServerSideEmitPayload_Mux_Drain,
    SocketClientSideEmitChannel_Open,
    SocketClientSideEmitChannel_Close,
    SocketClientSideEmitChannel_SendPacket,
    SocketClientSideEmitChannel_Mux_Open,
    SocketClientSideEmitChannel_Mux_Close,
    SocketClientSideEmitChannel_Mux_SendPacket,
    SocketClientSideEmitPayload_Open,
    SocketClientSideEmitPayload_Mux_Open,
    SocketClientSideEmitPayload_Mux_Close,
    SocketClientSideEmitPayload_Mux_SendPacket,
    SocketClientSideRpcChannel_Set,
    SocketClientSideRpcChannel_Update,
    SocketClientSideRpcChannel_Flush,
    SocketClientSideRpcChannel_Get,
    SocketClientSideRpcChannel_List,
    SocketClientSideRpcChannel_Mux_Set,
    SocketClientSideRpcChannel_Mux_Update,
    SocketClientSideRpcChannel_Mux_Flush,
    SocketClientSideRpcChannel_Mux_Get,
    SocketClientSideRpcPayload_Set,
    SocketClientSideRpcPayload_Update,
    SocketClientSideRpcPayload_Mux_Set,
    SocketClientSideRpcPayload_Mux_Update,
    SocketClientSideRpcPayload_Mux_Flush,
    SocketClientSideRpcPayload_Mux_Get,
    SocketRpcResponse_Status,
    SocketRpcResponse_List,
    SocketClientSideTxnChannel_Begin,
    SocketClientSideTxnChannel_Chunk,
    SocketClientSideTxnChannel_End,
    SocketClientSideTxnChannel_Abort,
    SocketClientSideTxnChannel_Mux_Begin,
    SocketClientSideTxnChannel_Mux_Chunk,
    SocketClientSideTxnChannel_Mux_End,
    SocketClientSideTxnChannel_Mux_Abort,
    SocketClientSideTxnPayload_Begin,
    SocketClientSideTxnPayload_Chunk,
    SocketClientSideTxnPayload_End,
    SocketClientSideTxnPayload_Abort,
    SocketClientSideTxnPayload_Mux_Begin,
    SocketClientSideTxnPayload_Mux_Chunk,
    SocketClientSideTxnPayload_Mux_End,
    SocketClientSideTxnPayload_Mux_Abort
} from "../types/remote-serialport-types/src/index";

import {
    AbsRemoteSerialServerSocket,
    AbsRemoteSerialServerSocketNamespace,
    AbsRemoteSerialServerSocketPort,
    AbsRemoteSerialServerMuxSocket,
    AbsRemoteSerialServerMuxSocketNamespace,
    AuthResult,
    AuthValidator,
    RemoteSerialServerAcl
} from "../types/remote-serialport-types/src/remote-serial-server.model";

import { OpenSerialPortOptions, SerialPortFactory, SerialPortLike, SerialPortListProvider, SetOptions, UpdateOptions, PortStatus, PortInfo } from "../types/remote-serialport-types/src/serialport";
import { Logger } from "../types/remote-serialport-types/src/logger";
import { default_logger } from "./logger";
import { SharedSessionRegistry, SharedSubscriberFacade } from "./shared-session";

/**
 * Default provider for the `serialport_list` RPC: the real {@link SerialPort.list}.
 */
export const default_serialport_list_provider: SerialPortListProvider = (): Promise<PortInfo[]> => {
    return SerialPort.list();
};

/**
 * Device→client wire backpressure tunables. When `socket.pipe()` forwards physical bytes, the
 * underlying socket.io transport's buffered byte count is sampled after each emit; if it exceeds
 * {@link WIRE_BACKPRESSURE_HIGH_WATER}, the physical port is `pause()`d. A periodic check
 * (every {@link WIRE_BACKPRESSURE_POLL_MS} ms) resumes once the buffer falls below
 * {@link WIRE_BACKPRESSURE_LOW_WATER}.
 */
export const WIRE_BACKPRESSURE_HIGH_WATER = 1024 * 1024; // 1 MB
export const WIRE_BACKPRESSURE_LOW_WATER = 256 * 1024;   // 256 KB
export const WIRE_BACKPRESSURE_POLL_MS = 50;

/**
 * Default physical-port factory: a real {@link SerialPort}.
 */
export const default_serialport_factory: SerialPortFactory = (options: OpenSerialPortOptions): SerialPortLike => {
    return new SerialPort(options) as unknown as SerialPortLike;
};

/**
 * The `socket.port` proxy: a thin {@link EventEmitter} bridging the physical serial port and the
 * socket layer in both directions (physical `data` -> `emit("data")`; `write()` / `"write-command"`
 * -> physical write). App code may sit in the middle, e.g. to transform bytes before forwarding.
 */
export class RemoteSerialServerSocketPort extends EventEmitter implements AbsRemoteSerialServerSocketPort {
    constructor() {
        super();
    }

    emit(event: "data", chunk: SerialPortPacket): boolean;
    emit(event: string | symbol, ...args: any[]): boolean;
    emit(event: string | symbol, ...args: any[]): boolean {
        return super.emit(event, ...args);
    }

    on(event: "data", listener: (data: SerialPortPacket) => void): this;
    on(event: "write-command", listener: (command: Buffer) => void): this;
    on(event: string | symbol, listener: (...args: any[]) => void): this;
    on(event: string | symbol, listener: (...args: any[]) => void): this {
        super.on(event, listener);
        return this;
    }

    once(event: "data", listener: (data: SerialPortPacket) => void): this;
    once(event: "write-command", listener: (command: Buffer) => void): this;
    once(event: string | symbol, listener: (...args: any[]) => void): this;
    once(event: string | symbol, listener: (...args: any[]) => void): this {
        super.once(event, listener);
        return this;
    }

    /**
     * Write bytes to the physical serial port (delivered via the `write-command` event).
     */
    write(data: Buffer): void {
        super.emit("write-command", data);
    }
}

/**
 * Callbacks a {@link PortSession} uses to talk back to its owning socket.
 */
interface PortSessionCallbacks {
    /** A lifecycle state change of the physical port. */
    on_state(state: RemoteSerialPortState, message?: string): void;
    /** A write packet has been handed to the physical port (i.e. the client may advance its send window). */
    on_write_ack(): void;
    /** A multi-chunk transaction timed out before `_end` / `_abort` arrived. */
    on_txn_timeout(txn_id: string, message: string): void;
}

/** Internal state for a buffered multi-chunk transaction. */
interface TxnBuffer {
    chunks: Buffer[];
    timer: ReturnType<typeof setTimeout>;
}

/**
 * One physical serial port plus its `socket.port` proxy and lifecycle state.
 *
 * Used by both modes: namespace mode keeps exactly one {@link PortSession} per socket; mux mode keeps
 * a `Map<path, PortSession>` per socket.
 */
export class PortSession {
    /** Local path of the physical port. Set on {@link open}. */
    public path: string = "";

    public readonly port: RemoteSerialServerSocketPort = new RemoteSerialServerSocketPort();

    private _serialport: SerialPortLike | null = null;

    private _state: RemoteSerialPortState = RemoteSerialPortState.IDLE;

    /** Set once {@link enable_read_forwarding} has been called (so a re-call is a no-op). */
    private _read_forwarding = false;

    private readonly _serialport_factory: SerialPortFactory;

    private readonly _cb: PortSessionCallbacks;

    private readonly _logger: Logger;

    private readonly _txn_timeout_ms: number;

    /** Buffered multi-chunk transactions, keyed by `txn_id`. */
    private readonly _txns: Map<string, TxnBuffer> = new Map();

    constructor(serialport_factory: SerialPortFactory, callbacks: PortSessionCallbacks, logger: Logger = default_logger, txn_timeout_ms: number = 5000) {
        this._serialport_factory = serialport_factory;
        this._cb = callbacks;
        this._logger = logger;
        this._txn_timeout_ms = txn_timeout_ms;
    }

    /* ---- multi-chunk transactions ---- */

    /** Start buffering a new transaction. No-op (with warning) if `txn_id` is already in flight. */
    txn_begin(txn_id: string): void {
        if (this._txns.has(txn_id)) {
            this._logger.warn(`duplicate txn_begin "${txn_id}" on "${this.path}"; ignoring`);
            return;
        }
        this._txns.set(txn_id, { chunks: [], timer: this._make_txn_timer(txn_id) });
    }

    /** Append a chunk to an open transaction; resets the per-txn timeout. */
    txn_chunk(txn_id: string, data: SerialPortPacket): void {
        const txn: TxnBuffer | undefined = this._txns.get(txn_id);
        if (txn === undefined) {
            this._logger.warn(`chunk for unknown txn "${txn_id}" on "${this.path}"; dropped`);
            return;
        }
        const buffer: Buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
        txn.chunks.push(buffer);
        clearTimeout(txn.timer);
        txn.timer = this._make_txn_timer(txn_id);
    }

    /**
     * Close a transaction: flush its concatenated buffer to the physical port and ack the client.
     * If the transaction is unknown (e.g. timed out earlier), still acks so the client's send
     * window doesn't stall — note: this means the client can't distinguish success from timeout
     * at the `tx.end()` Promise level (known limitation; see roadmap).
     */
    txn_end(txn_id: string): void {
        const txn: TxnBuffer | undefined = this._txns.get(txn_id);
        if (txn === undefined) {
            this._logger.warn(`end for unknown txn "${txn_id}" on "${this.path}"; ack-only`);
            process.nextTick((): void => this._cb.on_write_ack());
            return;
        }
        clearTimeout(txn.timer);
        this._txns.delete(txn_id);
        const combined: Buffer = txn.chunks.length === 1 ? txn.chunks[0] : Buffer.concat(txn.chunks as readonly Uint8Array[]);
        this.write_to_physical(combined);
    }

    /** Discard a transaction's buffered chunks. Does *not* ack (per protocol spec). */
    txn_abort(txn_id: string): void {
        const txn: TxnBuffer | undefined = this._txns.get(txn_id);
        if (txn === undefined) {
            return;
        }
        clearTimeout(txn.timer);
        this._txns.delete(txn_id);
        this._logger.debug(`txn "${txn_id}" aborted on "${this.path}"; ${txn.chunks.length} chunk(s) dropped`);
    }

    private _make_txn_timer(txn_id: string): ReturnType<typeof setTimeout> {
        return setTimeout((): void => this._on_txn_timeout(txn_id), this._txn_timeout_ms);
    }

    private _on_txn_timeout(txn_id: string): void {
        const txn: TxnBuffer | undefined = this._txns.get(txn_id);
        if (txn === undefined) {
            return;
        }
        this._txns.delete(txn_id);
        const message = `txn "${txn_id}" timed out after ${this._txn_timeout_ms}ms on "${this.path}" (${txn.chunks.length} chunk(s) buffered)`;
        this._logger.warn(message);
        this._cb.on_txn_timeout(txn_id, message);
    }

    get state(): RemoteSerialPortState {
        return this._state;
    }

    get is_open(): boolean {
        return this._state === RemoteSerialPortState.OPEN;
    }

    private _set_state(state: RemoteSerialPortState, message?: string): void {
        this._state = state;
        this._cb.on_state(state, message);
    }

    /**
     * Open the physical serial port at `path` with the given options. No-op if already opening / open.
     */
    open(path: string, options: OpenSerialPortOptions): void {
        if (this._state === RemoteSerialPortState.OPENING || this._state === RemoteSerialPortState.OPEN) {
            return;
        }
        this.path = path;
        this._set_state(RemoteSerialPortState.OPENING);

        let serialport: SerialPortLike;
        try {
            serialport = this._serialport_factory({ ...(options as any), path: path, autoOpen: false } as OpenSerialPortOptions);
        } catch (error: any) {
            this._set_state(RemoteSerialPortState.ERROR, error?.message ?? String(error));
            return;
        }
        this._serialport = serialport;

        serialport.open((error?: Error | null): void => {
            if (error) {
                this._serialport = null;
                this._set_state(RemoteSerialPortState.ERROR, error.message);
                return;
            }
            // physical -> proxy
            serialport.on("data", (chunk: Buffer): void => {
                this.port.emit("data", chunk);
            });
            // proxy "write-command" -> physical
            this.port.on("write-command", (command: Buffer): void => {
                if (this._serialport === null) {
                    return;
                }
                this._serialport.write(command);
            });
            serialport.on("error", (err: Error): void => {
                this._set_state(RemoteSerialPortState.ERROR, err.message);
            });
            serialport.on("close", (): void => {
                if (this._state !== RemoteSerialPortState.CLOSING && this._state !== RemoteSerialPortState.CLOSED) {
                    this._set_state(RemoteSerialPortState.CLOSED);
                }
            });
            this._set_state(RemoteSerialPortState.OPEN, "Serial port opened");
        });
    }

    /**
     * Enable forwarding of physical-port data to the wire via `on_data`. Idempotent. Called by `pipe()`.
     */
    enable_read_forwarding(on_data: (chunk: SerialPortPacket) => void): void {
        if (this._read_forwarding === true) {
            return;
        }
        this._read_forwarding = true;
        this.port.on("data", on_data);
    }

    /**
     * Write bytes (received from the wire) to the physical port, then acknowledge so the client can
     * advance its send window. If the port is not open the packet is dropped (with a warning) but
     * still acknowledged, so the client's window does not stall.
     */
    write_to_physical(data: SerialPortPacket): void {
        if (this.is_open === false || this._serialport === null) {
            this._logger.warn(`dropping write to "${this.path}": port not open (state=${this._state})`);
            process.nextTick((): void => this._cb.on_write_ack());
            return;
        }
        const buffer: Buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
        this.port.emit("write-command", buffer);
        // approximate backpressure: if the physical port wants a drain, ack only once it drains.
        if (this._serialport !== null && (this._serialport as { writableNeedDrain?: boolean }).writableNeedDrain === true) {
            this._serialport.once("drain", (): void => this._cb.on_write_ack());
        } else {
            process.nextTick((): void => this._cb.on_write_ack());
        }
    }

    /** Set modem control lines / break on the physical port (no-op if not open). */
    set_remote(options: SetOptions): void {
        this._serialport?.set(options, (): void => undefined);
    }

    /** Update the physical port, e.g. `baudRate` (no-op if not open). */
    update_remote(options: UpdateOptions): void {
        this._serialport?.update(options, (): void => undefined);
    }

    /** Flush the physical port's buffers (no-op if not open). */
    flush_remote(): void {
        this._serialport?.flush((): void => undefined);
    }

    /** Read the physical port's status (CTS / DSR / DCD). Rejects if the port is not open. */
    get_remote_status(): Promise<PortStatus> {
        return new Promise<PortStatus>((resolve, reject): void => {
            if (this._serialport === null) {
                reject(new Error(`serial port "${this.path}" is not open`));
                return;
            }
            this._serialport.get((error: Error | null, status?: PortStatus): void => {
                if (error || status === undefined) {
                    reject(error ?? new Error("failed to read serial port status"));
                } else {
                    resolve(status);
                }
            });
        });
    }

    /**
     * Close the physical port (does not affect the socket). Cancels any in-flight txn timers
     * before closing, so a port closed while transactions are buffering doesn't leak timers.
     */
    close(): void {
        for (const txn of this._txns.values()) {
            clearTimeout(txn.timer);
        }
        this._txns.clear();
        if (this._serialport === null) {
            this._set_state(RemoteSerialPortState.CLOSED);
            return;
        }
        this._set_state(RemoteSerialPortState.CLOSING);
        const serialport: SerialPortLike = this._serialport;
        serialport.close((error?: Error | null): void => {
            try {
                serialport.destroy();
            } catch {
                // ignore
            }
            this._serialport = null;
            this.port.removeAllListeners();
            this._read_forwarding = false;
            this._set_state(RemoteSerialPortState.CLOSED, error ? error.message : undefined);
        });
    }

    /**
     * Best-effort teardown (on disconnect): close + destroy + drop all listeners, without emitting state.
     * Also cancels any in-flight transaction timers (leak fix).
     */
    destroy(): void {
        for (const txn of this._txns.values()) {
            clearTimeout(txn.timer);
        }
        this._txns.clear();
        try {
            this._serialport?.close((): void => undefined);
        } catch {
            // ignore
        }
        try {
            this._serialport?.destroy();
        } catch {
            // ignore
        }
        this._serialport = null;
        this.port.removeAllListeners();
        this._read_forwarding = false;
        this._state = RemoteSerialPortState.CLOSED;
    }

    /**
     * Pause the underlying physical port (stops emitting `data` events until {@link resume_physical}).
     * Used by the server-side wire backpressure path: when the client's socket.io buffer is full,
     * stop draining bytes from the OS to avoid unbounded memory growth.
     * No-op if not open or if the underlying stream doesn't expose `pause()`.
     */
    pause_physical(): void {
        const port: { pause?: () => void } | null = this._serialport as unknown as ({ pause?: () => void } | null);
        port?.pause?.();
    }

    /** Resume after a {@link pause_physical}. No-op if not paused. */
    resume_physical(): void {
        const port: { resume?: () => void } | null = this._serialport as unknown as ({ resume?: () => void } | null);
        port?.resume?.();
    }
}

/* ============================================================================
 * Namespace mode
 * ========================================================================== */

/**
 * Server side of one remote serial port, addressed by a socket.io namespace.
 *
 * The write direction (client -> device) is wired automatically: incoming `serialport_send_packet`
 * is written to the physical port. The read direction (device -> client) is *not* forwarded by
 * default — app code listens on `socket.port` and decides whether/how to emit `serialport_packet`,
 * or calls {@link pipe} to auto-forward it.
 */
/**
 * Construction parameters for {@link RemoteSerialServerSocket}. Wrapped in an object because the
 * positional argument list has outgrown legibility.
 */
export interface RemoteSerialServerSocketParams {
    serialport_factory?: SerialPortFactory;
    strict_path?: boolean;
    port_list_provider?: SerialPortListProvider;
    logger?: Logger;
    txn_timeout_ms?: number;
    txn_timeout_action?: "log" | "state" | "both";
    shared_registry?: SharedSessionRegistry | null;
    auth_validator?: AuthValidator | null;
    acl?: RemoteSerialServerAcl | null;
    auto_pipe?: boolean;
}

export class RemoteSerialServerSocket extends AbsRemoteSerialServerSocket {
    protected _transport: AbsTransport;

    /**
     * In `multi_access: 'reject'` (default): a private {@link PortSession}.
     * In `multi_access: 'shared'`: a {@link SharedSubscriberFacade} backed by a per-path session
     * shared across all subscribing sockets.
     *
     * `null` until {@link _authenticate} has resolved with `ok: true`.
     */
    private _session: PortSession | SharedSubscriberFacade | null = null;

    private _identity: unknown = null;

    private readonly _serialport_factory: SerialPortFactory;
    private readonly _shared_registry: SharedSessionRegistry | null;
    private readonly _strict_path: boolean;
    private readonly _namespace_path: string;
    private readonly _port_list_provider: SerialPortListProvider;
    private readonly _logger: Logger;
    private readonly _txn_timeout_ms: number;
    private readonly _txn_timeout_action: "log" | "state" | "both";
    private readonly _acl: RemoteSerialServerAcl | null;
    private readonly _auto_pipe: boolean;

    /** Resolves with `true` if auth passed, `false` if rejected. Namespace wrapper gates `on("connection")` on this. */
    public readonly ready: Promise<boolean>;
    private _ready_resolve!: (ok: boolean) => void;

    /** Toggled by ACL `can_read` on open; if `true`, the pipe path drops outgoing `serialport_packet` frames. */
    private _read_denied = false;

    /** Wire-backpressure state for the device→client direction. Only used when `_session` is a private PortSession. */
    private _wire_paused = false;
    private _resume_timer: ReturnType<typeof setTimeout> | null = null;

    constructor(transport: AbsTransport, params: RemoteSerialServerSocketParams = {}) {
        super();
        this._transport = transport;
        this._serialport_factory = params.serialport_factory ?? default_serialport_factory;
        this._shared_registry = params.shared_registry ?? null;
        this._strict_path = params.strict_path ?? true;
        this._namespace_path = this.serialport_path;
        this._port_list_provider = params.port_list_provider ?? default_serialport_list_provider;
        this._logger = params.logger ?? default_logger;
        this._txn_timeout_ms = params.txn_timeout_ms ?? 5000;
        this._txn_timeout_action = params.txn_timeout_action ?? "log";
        this._acl = params.acl ?? null;
        this._auto_pipe = params.auto_pipe ?? false;

        this.ready = new Promise<boolean>((resolve): void => {
            this._ready_resolve = resolve;
        });

        // Disconnect cleanup runs regardless of auth outcome — close transport may itself trigger it.
        this._transport.on_lifecycle("disconnect", (): void => {
            if (this._resume_timer !== null) {
                clearTimeout(this._resume_timer);
                this._resume_timer = null;
            }
            this._session?.destroy();
        });

        // Kick off auth asynchronously; everything else (session, channel listeners, handshake) waits.
        void this._authenticate(params.auth_validator ?? null);
    }

    get identity(): unknown {
        return this._identity;
    }

    private async _authenticate(validator: AuthValidator | null): Promise<void> {
        const meta = { transport_id: this._transport.id, endpoint_label: this._transport.endpoint_label };
        let result: AuthResult;
        try {
            result = validator === null
                ? { ok: true, identity: null }
                : await Promise.resolve(validator(this._transport.credential, meta));
        } catch (e) {
            result = { ok: false, message: (e as Error)?.message ?? "auth validator threw" };
        }
        if (result.ok !== true) {
            this._logger.warn(`auth denied for transport "${this._transport.id}" on "${this._transport.endpoint_label}": ${result.message ?? "(no reason)"}`);
            this.emit("serialport_state", { state: RemoteSerialPortState.ERROR, message: result.message ?? "unauthorized" });
            this._transport.close();
            this._ready_resolve(false);
            return;
        }
        this._identity = result.identity ?? null;
        this._setup_session();
        this._wire_channel_listeners();
        this.emit("serialport_handshake", { protocolVersion: REMOTE_SERIALPORT_PROTOCOL_VERSION });
        if (this._auto_pipe === true) {
            this.pipe();
        }
        this._ready_resolve(true);
    }

    private _setup_session(): void {
        if (this._shared_registry !== null) {
            this._session = this._shared_registry.acquire(this._namespace_path, this._transport.id, {
                on_state: (state: RemoteSerialPortState, message?: string): void => {
                    this.emit("serialport_state", { state: state, message: message });
                },
                on_drain: (): void => {
                    this.emit("serialport_drain");
                },
                on_txn_timeout: (_txn_id: string, message: string): void => {
                    if (this._txn_timeout_action === "state" || this._txn_timeout_action === "both") {
                        this.emit("serialport_state", { state: RemoteSerialPortState.ERROR, message: message });
                    }
                },
                on_writer_promoted: (): void => {
                    this.emit("serialport_state", { state: RemoteSerialPortState.OPEN, message: "promoted to writer (pipe mode)" });
                }
            });
        } else {
            this._session = new PortSession(this._serialport_factory, {
                on_state: (state: RemoteSerialPortState, message?: string): void => {
                    this.emit("serialport_state", { state: state, message: message });
                },
                on_write_ack: (): void => {
                    this.emit("serialport_drain");
                },
                on_txn_timeout: (_txn_id: string, message: string): void => {
                    if (this._txn_timeout_action === "state" || this._txn_timeout_action === "both") {
                        this.emit("serialport_state", { state: RemoteSerialPortState.ERROR, message: message });
                    }
                }
            }, this._logger, this._txn_timeout_ms);
        }
    }

    private _wire_channel_listeners(): void {
        const session = this._session!;
        // client -> server: open the remote port
        this.once("serialport_open", async (request: SocketClientSideEmitPayload_Open): Promise<void> => {
            const resolved_path: string = this._resolve_port_path(request?.path);
            if (resolved_path === "") {
                this.emit("serialport_state", { state: RemoteSerialPortState.ERROR, message: "Invalid serial port path" });
                return;
            }
            if (this._acl?.can_open !== undefined) {
                let allowed = false;
                try {
                    allowed = await Promise.resolve(this._acl.can_open(this._identity, resolved_path)) === true;
                } catch (e) {
                    this._logger.warn(`acl.can_open threw for path "${resolved_path}": ${(e as Error).message}`);
                }
                if (allowed !== true) {
                    this.emit("serialport_state", { state: RemoteSerialPortState.ERROR, message: `open denied: "${resolved_path}"` });
                    return;
                }
            }
            // ACL read: one-shot ERROR if denied; subsequent pipe emits are filtered.
            if (this._acl?.can_read !== undefined) {
                const can_read = this._acl.can_read(this._identity, resolved_path) === true;
                if (can_read !== true) {
                    this._read_denied = true;
                    this.emit("serialport_state", { state: RemoteSerialPortState.ERROR, message: `read denied: "${resolved_path}"` });
                }
            }
            const options: OpenSerialPortOptions = (request?.options ?? {}) as OpenSerialPortOptions;
            session.open(resolved_path, options);
        });

        // client -> server: close the remote port
        this.on("serialport_close", (): void => {
            session.close();
        });

        // client -> server: write bytes to the physical port (always wired)
        this.on("serialport_send_packet", (data: SerialPortPacket): void => {
            if (this._check_write_acl() === false) {
                return;
            }
            session.write_to_physical(data);
        });

        // client -> server: remote physical-port control RPCs
        this.on("serialport_set", (request: SocketClientSideRpcPayload_Set): void => {
            if (this._check_write_acl() === false) {
                return;
            }
            session.set_remote(request.options);
        });
        this.on("serialport_update", (request: SocketClientSideRpcPayload_Update): void => {
            if (this._check_write_acl() === false) {
                return;
            }
            session.update_remote(request.options);
        });
        this.on("serialport_flush", (): void => {
            if (this._check_write_acl() === false) {
                return;
            }
            session.flush_remote();
        });
        this.on("serialport_get", (_data: Record<string, never>, ack: (response: SocketRpcResponse_Status) => void): void => {
            session.get_remote_status()
                .then((status: PortStatus): void => ack({ ok: true, status: status }))
                .catch((error: Error): void => ack({ ok: false, message: error.message }));
        });
        this.on("serialport_list", (_data: Record<string, never>, ack: (response: SocketRpcResponse_List) => void): void => {
            this._port_list_provider()
                .then((ports: PortInfo[]): void => ack({ ok: true, ports: ports }))
                .catch((error: Error): void => ack({ ok: false, message: error.message }));
        });

        // client -> server: multi-chunk transaction lifecycle
        this.on("serialport_send_begin", (request: SocketClientSideTxnPayload_Begin): void => {
            if (this._check_write_acl() === false) {
                return;
            }
            session.txn_begin(request.txn_id);
        });
        this.on("serialport_send_chunk", (request: SocketClientSideTxnPayload_Chunk): void => {
            session.txn_chunk(request.txn_id, request.data);
        });
        this.on("serialport_send_end", (request: SocketClientSideTxnPayload_End): void => {
            if (this._check_write_acl() === false) {
                // Drain the window so the client's `tx.end()` doesn't stall on a denied txn.
                this.emit("serialport_drain");
                session.txn_abort(request.txn_id);
                return;
            }
            session.txn_end(request.txn_id);
        });
        this.on("serialport_send_abort", (request: SocketClientSideTxnPayload_Abort): void => {
            session.txn_abort(request.txn_id);
        });
    }

    /**
     * Per-write ACL check. Returns `true` to allow, `false` to deny. On deny: emits a state ERROR
     * to the originator and drains the backpressure window (server-side) by sending `serialport_drain`,
     * so subsequent legitimate writes are not stalled.
     */
    private _check_write_acl(): boolean {
        if (this._acl?.can_write === undefined) {
            return true;
        }
        if (this._acl.can_write(this._identity, this._namespace_path) === true) {
            return true;
        }
        this.emit("serialport_state", { state: RemoteSerialPortState.ERROR, message: `write denied: "${this._namespace_path}"` });
        this.emit("serialport_drain");
        return false;
    }

    private _resolve_port_path(requested_path: string | undefined): string {
        if (this._strict_path === false && typeof requested_path === "string" && requested_path.length > 0) {
            return requested_path;
        }
        return this._namespace_path;
    }

    get state(): RemoteSerialPortState {
        return this._session?.state ?? RemoteSerialPortState.IDLE;
    }

    get port(): AbsRemoteSerialServerSocketPort {
        if (this._session === null) {
            throw new Error("socket is not authorized yet; await `socket.ready` (or use it from inside the `connection` handler) before accessing .port");
        }
        return this._session.port;
    }

    /**
     * Enable auto-forwarding of physical-port data to the client (`serialport_packet`). Idempotent.
     * Don't combine with manually emitting `serialport_packet` from a `socket.port.on("data")`
     * handler — data would be forwarded twice. The write direction is already wired automatically.
     *
     * Also installs device→client wire backpressure: if the underlying socket.io transport buffers
     * past {@link WIRE_BACKPRESSURE_HIGH_WATER} bytes, the physical port is `pause()`d until the
     * buffer drops below {@link WIRE_BACKPRESSURE_LOW_WATER}. Only effective in `multi_access:'reject'`
     * (private PortSession); shared mode skips this since pause/resume is global per physical port.
     */
    pipe(): void {
        if (this._session === null) {
            return; // pre-auth (auto_pipe will retry after auth completes; user-side pipe is gated by `connection`)
        }
        this._session.enable_read_forwarding((chunk: SerialPortPacket): void => {
            if (this._read_denied === true) {
                return; // ACL read deny: silently filter outgoing fanout to this client
            }
            this.emit("serialport_packet", chunk);
            this._check_wire_backpressure();
        });
    }

    private _check_wire_backpressure(): void {
        if (this._session_is_shared() === true || this._session === null) {
            return; // shared mode: physical port is shared, per-socket pause would starve others
        }
        const buffered: number = this._get_buffered_amount();
        if (buffered > WIRE_BACKPRESSURE_HIGH_WATER && this._wire_paused === false) {
            this._wire_paused = true;
            (this._session as PortSession).pause_physical();
            this._schedule_resume_check();
        }
    }

    private _schedule_resume_check(): void {
        if (this._resume_timer !== null) {
            return;
        }
        const t: ReturnType<typeof setTimeout> = setTimeout((): void => {
            this._resume_timer = null;
            if (this._wire_paused === false || this._session === null) {
                return;
            }
            if (this._get_buffered_amount() < WIRE_BACKPRESSURE_LOW_WATER) {
                this._wire_paused = false;
                (this._session as PortSession).resume_physical();
            } else {
                this._schedule_resume_check();
            }
        }, WIRE_BACKPRESSURE_POLL_MS);
        // T4: don't keep the process alive just for the wire-backpressure poll. The poll fires
        // again on each emit even if there's no listener, and disconnect cleanup clears it
        // explicitly — `.unref()` is consistent with D3/D4/index.ts unref'd timers.
        if (typeof (t as { unref?: () => void }).unref === "function") {
            (t as { unref: () => void }).unref();
        }
        this._resume_timer = t;
    }

    private _get_buffered_amount(): number {
        // Transport may report `null` if it cannot inspect a wire buffer (e.g. in-process IPC);
        // treat that as "no backpressure" so the high-water check never trips.
        return this._transport.get_buffered_amount() ?? 0;
    }

    private _session_is_shared(): boolean {
        return (this._session instanceof PortSession) === false;
    }

    emit(channel: SocketServerSideEmitChannel_Handshake, message: SocketServerSideEmitPayload_Handshake): void;
    emit(channel: SocketServerSideEmitChannel_State, message: SocketServerSideEmitPayload_State): void;
    emit(channel: SocketServerSideEmitChannel_Packet, message: SerialPortPacket): void;
    emit(channel: SocketServerSideEmitChannel_Drain): void;
    emit(channel: string, message?: any): void {
        if (arguments.length < 2) {
            this._transport.send(channel);
        } else {
            this._transport.send(channel, message);
        }
    }

    on(channel: SocketClientSideEmitChannel_Open, listener: (data: SocketClientSideEmitPayload_Open) => void): void;
    on(channel: SocketClientSideEmitChannel_Close, listener: () => void): void;
    on(channel: SocketClientSideEmitChannel_SendPacket, listener: (data: SerialPortPacket) => void): void;
    on(channel: SocketClientSideRpcChannel_Set, listener: (data: SocketClientSideRpcPayload_Set) => void): void;
    on(channel: SocketClientSideRpcChannel_Update, listener: (data: SocketClientSideRpcPayload_Update) => void): void;
    on(channel: SocketClientSideRpcChannel_Flush, listener: () => void): void;
    on(channel: SocketClientSideRpcChannel_Get, listener: (data: Record<string, never>, ack: (response: SocketRpcResponse_Status) => void) => void): void;
    on(channel: SocketClientSideRpcChannel_List, listener: (data: Record<string, never>, ack: (response: SocketRpcResponse_List) => void) => void): void;
    on(channel: SocketClientSideTxnChannel_Begin, listener: (data: SocketClientSideTxnPayload_Begin) => void): void;
    on(channel: SocketClientSideTxnChannel_Chunk, listener: (data: SocketClientSideTxnPayload_Chunk) => void): void;
    on(channel: SocketClientSideTxnChannel_End, listener: (data: SocketClientSideTxnPayload_End) => void): void;
    on(channel: SocketClientSideTxnChannel_Abort, listener: (data: SocketClientSideTxnPayload_Abort) => void): void;
    on(channel: string, listener: (...args: any[]) => void): void {
        this._transport.on(channel, listener);
    }

    once(channel: SocketClientSideEmitChannel_Open, listener: (data: SocketClientSideEmitPayload_Open) => void): void;
    once(channel: SocketClientSideEmitChannel_Close, listener: () => void): void;
    once(channel: SocketClientSideEmitChannel_SendPacket, listener: (data: SerialPortPacket) => void): void;
    once(channel: string, listener: (...args: any[]) => void): void {
        this._transport.once(channel, listener);
    }

    disconnect(_close?: boolean): void {
        // socket.io's `close=false` (leave-this-socket-only) semantic is socket.io-specific and not
        // exposed through AbsTransport; transports always close fully.
        this._transport.close();
    }
}

/**
 * Wraps a socket.io namespace; emits {@link RemoteSerialServerSocket}s (built via the injected
 * factory, so they share the server's `socket_map`) on `connection`.
 */
export class RemoteSerialServerSocketNamespace extends AbsRemoteSerialServerSocketNamespace<RemoteSerialServerSocket> {
    protected _endpoint: AbsTransportEndpoint;

    private readonly _socket_factory: (transport: AbsTransport) => RemoteSerialServerSocket;

    /** Called once when the first `on("connection", ...)` is registered, so the parent server can
     *  detect "user forgot to register" and warn. */
    private readonly _on_connection_listener_registered: () => void;

    constructor(
        endpoint: AbsTransportEndpoint,
        socket_factory: (transport: AbsTransport) => RemoteSerialServerSocket,
        on_connection_listener_registered: () => void = (): void => undefined
    ) {
        super();
        this._endpoint = endpoint;
        this._socket_factory = socket_factory;
        this._on_connection_listener_registered = on_connection_listener_registered;
    }

    on(channel: SocketIONamespaceOnEvent, listener: (socket: RemoteSerialServerSocket) => void): void {
        if (channel !== "connection") {
            // `disconnect` / `error` are per-transport events, not endpoint-level — listen on the
            // individual `RemoteSerialServerSocket` instances delivered to the `connection` callback.
            return;
        }
        this._on_connection_listener_registered();
        this._endpoint.on_connection((transport: AbsTransport): void => {
            const socket: RemoteSerialServerSocket = this._socket_factory(transport);
            // Gate the user's `connection` callback on auth: only deliver authorized sockets so app
            // code can safely access `socket.port`, call `pipe()`, etc. without checking auth itself.
            socket.ready.then((ok: boolean): void => {
                if (ok === true) {
                    listener(socket);
                }
            });
        });
    }
}

/* ============================================================================
 * Mux mode
 * ========================================================================== */

/**
 * Server side of a mux connection: one socket carrying many remote serial ports, each addressed by
 * `path` inside the payloads. The write direction is wired automatically per port; the read
 * direction is forwarded only after {@link pipe} is called.
 */
/**
 * Construction parameters for {@link RemoteSerialServerMuxSocket}. Wrapped in an object for the
 * same reason as {@link RemoteSerialServerSocketParams}.
 */
export interface RemoteSerialServerMuxSocketParams {
    serialport_factory?: SerialPortFactory;
    strict_path?: boolean;
    port_list_provider?: SerialPortListProvider;
    logger?: Logger;
    txn_timeout_ms?: number;
    txn_timeout_action?: "log" | "state" | "both";
    shared_registry?: SharedSessionRegistry | null;
    auth_validator?: AuthValidator | null;
    acl?: RemoteSerialServerAcl | null;
    auto_pipe?: boolean;
}

export class RemoteSerialServerMuxSocket extends AbsRemoteSerialServerMuxSocket {
    protected _transport: AbsTransport;

    /**
     * Per-`path` session for each remote port this mux socket has touched. A `PortSession` in
     * `multi_access: 'reject'` mode, a {@link SharedSubscriberFacade} in `'shared'` mode (so the
     * underlying physical port may be shared with other mux/namespace sockets via the registry).
     */
    private readonly _sessions: Map<string, PortSession | SharedSubscriberFacade> = new Map();

    /** Per-path ACL read deny set; populated on `serialport_mux_open` via `acl.can_read`. */
    private readonly _read_denied: Set<string> = new Set();

    private _identity: unknown = null;

    private readonly _serialport_factory: SerialPortFactory;
    private readonly _strict_path: boolean;
    private readonly _port_list_provider: SerialPortListProvider;
    private readonly _logger: Logger;
    private readonly _txn_timeout_ms: number;
    private readonly _txn_timeout_action: "log" | "state" | "both";
    private readonly _shared_registry: SharedSessionRegistry | null;
    private readonly _acl: RemoteSerialServerAcl | null;
    private readonly _auto_pipe: boolean;

    private _read_forwarding = false;

    /** Resolves with `true` if auth passed, `false` if rejected. */
    public readonly ready: Promise<boolean>;
    private _ready_resolve!: (ok: boolean) => void;

    constructor(transport: AbsTransport, params: RemoteSerialServerMuxSocketParams = {}) {
        super();
        this._transport = transport;
        this._serialport_factory = params.serialport_factory ?? default_serialport_factory;
        this._strict_path = params.strict_path ?? true;
        this._port_list_provider = params.port_list_provider ?? default_serialport_list_provider;
        this._logger = params.logger ?? default_logger;
        this._txn_timeout_ms = params.txn_timeout_ms ?? 5000;
        this._txn_timeout_action = params.txn_timeout_action ?? "log";
        this._shared_registry = params.shared_registry ?? null;
        this._acl = params.acl ?? null;
        this._auto_pipe = params.auto_pipe ?? false;

        this.ready = new Promise<boolean>((resolve): void => {
            this._ready_resolve = resolve;
        });

        this._transport.on_lifecycle("disconnect", (): void => {
            for (const session of this._sessions.values()) {
                session.destroy();
            }
            this._sessions.clear();
        });

        void this._authenticate(params.auth_validator ?? null);
    }

    get identity(): unknown {
        return this._identity;
    }

    private async _authenticate(validator: AuthValidator | null): Promise<void> {
        const meta = { transport_id: this._transport.id, endpoint_label: this._transport.endpoint_label };
        let result: AuthResult;
        try {
            result = validator === null
                ? { ok: true, identity: null }
                : await Promise.resolve(validator(this._transport.credential, meta));
        } catch (e) {
            result = { ok: false, message: (e as Error)?.message ?? "auth validator threw" };
        }
        if (result.ok !== true) {
            this._logger.warn(`auth denied for mux transport "${this._transport.id}" on "${this._transport.endpoint_label}": ${result.message ?? "(no reason)"}`);
            // Mux state channel requires a path; emit a global error via path="" and close the
            // transport. Client-side mux socket can detect "disconnect before handshake" as auth failure.
            this.emit("serialport_mux_state", { path: "", state: RemoteSerialPortState.ERROR, message: result.message ?? "unauthorized" });
            this._transport.close();
            this._ready_resolve(false);
            return;
        }
        this._identity = result.identity ?? null;
        this._wire_channel_listeners();
        this.emit("serialport_handshake", { protocolVersion: REMOTE_SERIALPORT_PROTOCOL_VERSION });
        if (this._auto_pipe === true) {
            this.pipe();
        }
        this._ready_resolve(true);
    }

    private _wire_channel_listeners(): void {
        this.on("serialport_mux_open", async (request: SocketClientSideEmitPayload_Mux_Open): Promise<void> => {
            const path: string = request?.path ?? "";
            if (path === "" || (this._strict_path === true && this._is_invalid_path(path))) {
                this.emit("serialport_mux_state", { path: path, state: RemoteSerialPortState.ERROR, message: "Invalid serial port path" });
                return;
            }
            if (this._acl?.can_open !== undefined) {
                let allowed = false;
                try {
                    allowed = await Promise.resolve(this._acl.can_open(this._identity, path)) === true;
                } catch (e) {
                    this._logger.warn(`acl.can_open threw for path "${path}": ${(e as Error).message}`);
                }
                if (allowed !== true) {
                    this.emit("serialport_mux_state", { path: path, state: RemoteSerialPortState.ERROR, message: `open denied: "${path}"` });
                    return;
                }
            }
            if (this._acl?.can_read !== undefined) {
                const can_read = this._acl.can_read(this._identity, path) === true;
                if (can_read !== true) {
                    this._read_denied.add(path);
                    this.emit("serialport_mux_state", { path: path, state: RemoteSerialPortState.ERROR, message: `read denied: "${path}"` });
                }
            }
            const options: OpenSerialPortOptions = (request?.options ?? {}) as OpenSerialPortOptions;
            this._get_or_create_session(path).open(path, options);
        });

        this.on("serialport_mux_close", (request: SocketClientSideEmitPayload_Mux_Close): void => {
            const path: string = request?.path ?? "";
            this._sessions.get(path)?.close();
        });

        this.on("serialport_mux_send_packet", (message: SocketClientSideEmitPayload_Mux_SendPacket): void => {
            const path: string = message?.path ?? "";
            if (this._check_write_acl(path) === false) {
                return;
            }
            const session: PortSession | SharedSubscriberFacade | undefined = this._sessions.get(path);
            if (session === undefined) {
                // unknown port: still ack so the client window does not stall
                this.emit("serialport_mux_drain", { path: path });
                return;
            }
            session.write_to_physical(message.data);
        });

        // remote physical-port control RPCs (per path)
        this.on("serialport_mux_set", (request: SocketClientSideRpcPayload_Mux_Set): void => {
            const path: string = request?.path ?? "";
            if (this._check_write_acl(path) === false) {
                return;
            }
            this._sessions.get(path)?.set_remote(request.options);
        });
        this.on("serialport_mux_update", (request: SocketClientSideRpcPayload_Mux_Update): void => {
            const path: string = request?.path ?? "";
            if (this._check_write_acl(path) === false) {
                return;
            }
            this._sessions.get(path)?.update_remote(request.options);
        });
        this.on("serialport_mux_flush", (request: SocketClientSideRpcPayload_Mux_Flush): void => {
            const path: string = request?.path ?? "";
            if (this._check_write_acl(path) === false) {
                return;
            }
            this._sessions.get(path)?.flush_remote();
        });
        this.on("serialport_mux_get", (request: SocketClientSideRpcPayload_Mux_Get, ack: (response: SocketRpcResponse_Status) => void): void => {
            const session: PortSession | SharedSubscriberFacade | undefined = this._sessions.get(request?.path ?? "");
            if (session === undefined) {
                ack({ ok: false, message: `serial port "${request?.path ?? ""}" is not open` });
                return;
            }
            session.get_remote_status()
                .then((status: PortStatus): void => ack({ ok: true, status: status }))
                .catch((error: Error): void => ack({ ok: false, message: error.message }));
        });
        this.on("serialport_list", (_data: Record<string, never>, ack: (response: SocketRpcResponse_List) => void): void => {
            this._port_list_provider()
                .then((ports: PortInfo[]): void => ack({ ok: true, ports: ports }))
                .catch((error: Error): void => ack({ ok: false, message: error.message }));
        });

        // multi-chunk transactions, per path
        this.on("serialport_mux_send_begin", (request: SocketClientSideTxnPayload_Mux_Begin): void => {
            if (this._check_write_acl(request.path) === false) {
                return;
            }
            this._get_or_create_session(request.path).txn_begin(request.txn_id);
        });
        this.on("serialport_mux_send_chunk", (request: SocketClientSideTxnPayload_Mux_Chunk): void => {
            this._sessions.get(request.path)?.txn_chunk(request.txn_id, request.data);
        });
        this.on("serialport_mux_send_end", (request: SocketClientSideTxnPayload_Mux_End): void => {
            if (this._check_write_acl(request.path) === false) {
                this.emit("serialport_mux_drain", { path: request.path });
                this._sessions.get(request.path)?.txn_abort(request.txn_id);
                return;
            }
            const session: PortSession | SharedSubscriberFacade | undefined = this._sessions.get(request.path);
            if (session === undefined) {
                this.emit("serialport_mux_drain", { path: request.path });
                return;
            }
            session.txn_end(request.txn_id);
        });
        this.on("serialport_mux_send_abort", (request: SocketClientSideTxnPayload_Mux_Abort): void => {
            this._sessions.get(request.path)?.txn_abort(request.txn_id);
        });
    }

    /**
     * Per-write ACL check (mux variant). Returns `true` to allow, `false` to deny. On deny: emits
     * a per-path state ERROR + drains the per-path backpressure window so subsequent legitimate
     * writes are not stalled.
     */
    private _check_write_acl(path: string): boolean {
        if (this._acl?.can_write === undefined) {
            return true;
        }
        if (this._acl.can_write(this._identity, path) === true) {
            return true;
        }
        this.emit("serialport_mux_state", { path: path, state: RemoteSerialPortState.ERROR, message: `write denied: "${path}"` });
        this.emit("serialport_mux_drain", { path: path });
        return false;
    }

    private _is_invalid_path(path: string): boolean {
        // permissive guard (the server's namespace regexp is namespace-oriented, not path-oriented)
        return /^(\/dev\/tty[A-Za-z0-9]+|\/?COM[0-9]+)$/.test(path) === false;
    }

    private _get_or_create_session(path: string): PortSession | SharedSubscriberFacade {
        const existing: PortSession | SharedSubscriberFacade | undefined = this._sessions.get(path);
        if (existing !== undefined) {
            return existing;
        }
        let session: PortSession | SharedSubscriberFacade;
        if (this._shared_registry !== null) {
            // Shared mode: acquire from the server-level registry. Same underlying SharedPortSession
            // can be shared with namespace-mode sockets + other mux sockets on the same path.
            session = this._shared_registry.acquire(path, this._transport.id, {
                on_state: (state: RemoteSerialPortState, message?: string): void => {
                    this.emit("serialport_mux_state", { path: path, state: state, message: message });
                    if (state === RemoteSerialPortState.CLOSED) {
                        this._sessions.delete(path);
                    }
                },
                on_drain: (): void => {
                    this.emit("serialport_mux_drain", { path: path });
                },
                on_txn_timeout: (_txn_id: string, message: string): void => {
                    if (this._txn_timeout_action === "state" || this._txn_timeout_action === "both") {
                        this.emit("serialport_mux_state", { path: path, state: RemoteSerialPortState.ERROR, message: message });
                    }
                },
                on_writer_promoted: (): void => {
                    this.emit("serialport_mux_state", { path: path, state: RemoteSerialPortState.OPEN, message: "promoted to writer (pipe mode)" });
                }
            });
        } else {
            session = new PortSession(this._serialport_factory, {
                on_state: (state: RemoteSerialPortState, message?: string): void => {
                    this.emit("serialport_mux_state", { path: path, state: state, message: message });
                    if (state === RemoteSerialPortState.CLOSED) {
                        this._sessions.delete(path);
                    }
                },
                on_write_ack: (): void => {
                    this.emit("serialport_mux_drain", { path: path });
                },
                on_txn_timeout: (_txn_id: string, message: string): void => {
                    if (this._txn_timeout_action === "state" || this._txn_timeout_action === "both") {
                        this.emit("serialport_mux_state", { path: path, state: RemoteSerialPortState.ERROR, message: message });
                    }
                }
            }, this._logger, this._txn_timeout_ms);
        }
        if (this._read_forwarding === true) {
            session.enable_read_forwarding((chunk: SerialPortPacket): void => {
                if (this._read_denied.has(path) === true) {
                    return; // ACL read deny: silently filter per-path fanout
                }
                this.emit("serialport_mux_packet", { path: path, data: chunk });
            });
        }
        this._sessions.set(path, session);
        return session;
    }

    get_state(path: string): RemoteSerialPortState {
        return this._sessions.get(path)?.state ?? RemoteSerialPortState.IDLE;
    }

    port(path: string): AbsRemoteSerialServerSocketPort {
        return this._get_or_create_session(path).port;
    }

    /**
     * Enable auto-forwarding of physical data to the client for every port (existing and future) on
     * this mux connection. Idempotent.
     */
    pipe(): void {
        if (this._read_forwarding === true) {
            return;
        }
        this._read_forwarding = true;
        for (const [path, session] of this._sessions) {
            session.enable_read_forwarding((chunk: SerialPortPacket): void => {
                if (this._read_denied.has(path) === true) {
                    return;
                }
                this.emit("serialport_mux_packet", { path: path, data: chunk });
            });
        }
    }

    emit(channel: SocketServerSideEmitChannel_Handshake, message: SocketServerSideEmitPayload_Handshake): void;
    emit(channel: SocketServerSideEmitChannel_Mux_State, message: SocketServerSideEmitPayload_Mux_State): void;
    emit(channel: SocketServerSideEmitChannel_Mux_Packet, message: SocketServerSideEmitPayload_Mux_Packet): void;
    emit(channel: SocketServerSideEmitChannel_Mux_Drain, message: SocketServerSideEmitPayload_Mux_Drain): void;
    emit(channel: string, message?: any): void {
        if (arguments.length < 2) {
            this._transport.send(channel);
        } else {
            this._transport.send(channel, message);
        }
    }

    on(channel: SocketClientSideEmitChannel_Mux_Open, listener: (data: SocketClientSideEmitPayload_Mux_Open) => void): void;
    on(channel: SocketClientSideEmitChannel_Mux_Close, listener: (data: SocketClientSideEmitPayload_Mux_Close) => void): void;
    on(channel: SocketClientSideEmitChannel_Mux_SendPacket, listener: (data: SocketClientSideEmitPayload_Mux_SendPacket) => void): void;
    on(channel: SocketClientSideRpcChannel_Mux_Set, listener: (data: SocketClientSideRpcPayload_Mux_Set) => void): void;
    on(channel: SocketClientSideRpcChannel_Mux_Update, listener: (data: SocketClientSideRpcPayload_Mux_Update) => void): void;
    on(channel: SocketClientSideRpcChannel_Mux_Flush, listener: (data: SocketClientSideRpcPayload_Mux_Flush) => void): void;
    on(channel: SocketClientSideRpcChannel_Mux_Get, listener: (data: SocketClientSideRpcPayload_Mux_Get, ack: (response: SocketRpcResponse_Status) => void) => void): void;
    on(channel: SocketClientSideRpcChannel_List, listener: (data: Record<string, never>, ack: (response: SocketRpcResponse_List) => void) => void): void;
    on(channel: SocketClientSideTxnChannel_Mux_Begin, listener: (data: SocketClientSideTxnPayload_Mux_Begin) => void): void;
    on(channel: SocketClientSideTxnChannel_Mux_Chunk, listener: (data: SocketClientSideTxnPayload_Mux_Chunk) => void): void;
    on(channel: SocketClientSideTxnChannel_Mux_End, listener: (data: SocketClientSideTxnPayload_Mux_End) => void): void;
    on(channel: SocketClientSideTxnChannel_Mux_Abort, listener: (data: SocketClientSideTxnPayload_Mux_Abort) => void): void;
    on(channel: string, listener: (...args: any[]) => void): void {
        this._transport.on(channel, listener);
    }

    once(channel: SocketClientSideEmitChannel_Mux_Open, listener: (data: SocketClientSideEmitPayload_Mux_Open) => void): void;
    once(channel: SocketClientSideEmitChannel_Mux_Close, listener: (data: SocketClientSideEmitPayload_Mux_Close) => void): void;
    once(channel: SocketClientSideEmitChannel_Mux_SendPacket, listener: (data: SocketClientSideEmitPayload_Mux_SendPacket) => void): void;
    once(channel: string, listener: (...args: any[]) => void): void {
        this._transport.once(channel, listener);
    }

    disconnect(_close?: boolean): void {
        this._transport.close();
    }
}

/**
 * Wraps a socket.io namespace; emits {@link RemoteSerialServerMuxSocket}s on `connection`.
 */
export class RemoteSerialServerMuxSocketNamespace extends AbsRemoteSerialServerMuxSocketNamespace<RemoteSerialServerMuxSocket> {
    protected _endpoint: AbsTransportEndpoint;

    private readonly _socket_factory: (transport: AbsTransport) => RemoteSerialServerMuxSocket;

    private readonly _on_connection_listener_registered: () => void;

    constructor(
        endpoint: AbsTransportEndpoint,
        socket_factory: (transport: AbsTransport) => RemoteSerialServerMuxSocket,
        on_connection_listener_registered: () => void = (): void => undefined
    ) {
        super();
        this._endpoint = endpoint;
        this._socket_factory = socket_factory;
        this._on_connection_listener_registered = on_connection_listener_registered;
    }

    on(channel: SocketIONamespaceOnEvent, listener: (socket: RemoteSerialServerMuxSocket) => void): void {
        if (channel !== "connection") {
            return;
        }
        this._on_connection_listener_registered();
        this._endpoint.on_connection((transport: AbsTransport): void => {
            const socket: RemoteSerialServerMuxSocket = this._socket_factory(transport);
            socket.ready.then((ok: boolean): void => {
                if (ok === true) {
                    listener(socket);
                }
            });
        });
    }
}
