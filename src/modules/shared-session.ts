import { Logger } from "../types/remote-serialport-types/src/logger";
import { OpenSerialPortOptions, SerialPortFactory, PortStatus, SetOptions, UpdateOptions } from "../types/remote-serialport-types/src/serialport";
import { RemoteSerialPortState, SerialPortPacket } from "../types/remote-serialport-types/src/index";
import { AbsRemoteSerialServerSocketPort } from "../types/remote-serialport-types/src/remote-serial-server.model";
import { PortSession } from "./socket";
import { default_logger } from "./logger";

/**
 * Scheduling/writer policy for `multi_access: 'shared'`. See {@link RemoteSerialServerOptions.shared_mode}.
 *
 * - `'fifo'` (default): writes serialize by arrival order at the underlying Node Stream.
 * - `'fifo-strict'`: one in-flight `_end` at a time across all subscribers (stop-and-wait).
 * - `'batch'`: order by `_end` arrival instead of `_begin`.
 * - `'pipe'`: only the earliest-connected subscriber is the writer; others read-only. Writer
 *   disconnect auto-promotes the next earliest live subscriber.
 * - `'cow-write-isolate'`: shared fanout + best-effort echo filter (per-subscriber recent-write
 *   memory; device bytes that prefix-match are routed only to the originator).
 * - `'cow-snapshot'`: shared fanout + per-subscriber ring buffer replay on subscribe.
 * - `'cow-virtual-port'`: per-subscriber `set`/`update`/`get` state; physical applies last-wins.
 */
export type SharedMode = "fifo" | "fifo-strict" | "batch" | "pipe" | "cow-write-isolate" | "cow-snapshot" | "cow-virtual-port";

/** Per-subscriber callbacks the {@link SharedPortSession} invokes for routed events. */
export interface SubscriberCallbacks {
    /** A state change of the shared physical port. Fanned out to all subscribers. */
    on_state(state: RemoteSerialPortState, message?: string): void;
    /** A write originating from *this* subscriber drained on the physical port. */
    on_drain(): void;
    /** A txn originating from *this* subscriber timed out (the underlying namespacing is hidden). */
    on_txn_timeout(txn_id: string, message: string): void;
    /** Only fires in `'pipe'` mode: this subscriber just became the writer (e.g. predecessor disconnected). */
    on_writer_promoted?(): void;
}

interface SubscriberRecord {
    id: string;
    callbacks: SubscriberCallbacks;
    /** Listener functions this subscriber added to the shared `port.on("data")` for cleanup on unsubscribe. */
    data_listeners: Set<(chunk: SerialPortPacket) => void>;
}

/** Entry in the {@link SharedPortSession} scheduling queue (only used by `'fifo'` / `'fifo-strict'`). */
interface ScheduleEntry {
    subscriber_id: string;
    /** `'packet'` = single-shot (atomic on arrival); `'txn'` = multi-chunk, body buffered in PortSession. */
    kind: "packet" | "txn";
    /** For `'packet'`: the bytes; for `'txn'`: `null` (bytes are in PortSession's txn buffer). */
    data: SerialPortPacket | null;
    /** For `'txn'`: the namespaced txn key in PortSession; for `'packet'`: `null`. */
    namespaced_txn_id: string | null;
    /** `true` when this entry can be dispatched (single-shot: at push; txn: only after `_end` arrives). */
    ready: boolean;
}

/**
 * One shared physical serial port + N subscriber sockets (refcounted). Lives in the server-level
 * registry, keyed by path. Subscribers get drain acks routed by FIFO origin tracking, and txn
 * timeouts via subscriber-id-namespaced txn keys on the underlying {@link PortSession}.
 */
export class SharedPortSession {
    public readonly path: string;

    private readonly _session: PortSession;

    private readonly _shared_mode: SharedMode;

    private readonly _logger: Logger;

    private readonly _subscribers: Map<string, SubscriberRecord> = new Map();

    /** Subscriber ids in `subscribe()` order, for pipe writer election. */
    private readonly _subscribe_order: string[] = [];

    /**
     * Origin of each in-flight write (single-shot packet or txn `_end`), in FIFO matching Node
     * Stream's write order. Shifted by the underlying PortSession's `on_write_ack`.
     */
    private readonly _pending_ack_origins: Array<string | null> = [];

    /** Pipe-mode writer: earliest live subscriber. `null` if no subscribers (transient). */
    private _writer_id: string | null = null;

    private _opened = false;

    /**
     * Per-write scheduling queue used by `'fifo'` (HOL by `_begin` arrival) and `'fifo-strict'`
     * (same as `'fifo'` plus a single-in-flight constraint). Empty / unused in `'batch'` and `'pipe'`.
     */
    private readonly _schedule_queue: ScheduleEntry[] = [];

    /** Used by `'fifo-strict'`: there is currently a write between `_session.write_to_physical` and `on_write_ack`. */
    private _strict_in_flight = false;

    /**
     * Per-subscriber `on_data` callbacks (replaces the previous direct attach-to-port pattern). All
     * device→client routing flows through {@link _dispatch_data} so COW modes can filter or replay.
     */
    private readonly _data_callbacks: Map<string, (chunk: SerialPortPacket) => void> = new Map();

    /** Used by `cow-write-isolate`: queue of expected echo bytes per subscriber (their recent writes). */
    private readonly _pending_echo: Map<string, Buffer[]> = new Map();

    /** Used by `cow-snapshot`: ring buffer of recent device output, replayed to new subscribers. */
    private readonly _snapshot_buffer: Buffer[] = [];
    private _snapshot_bytes = 0;
    private readonly _snapshot_max_bytes: number;

    /** Used by `cow-virtual-port`: cached per-subscriber set/update state for conflict warnings. */
    private readonly _subscriber_set_state: Map<string, SetOptions> = new Map();
    private readonly _subscriber_update_state: Map<string, UpdateOptions> = new Map();
    private _last_set_origin: string | null = null;
    private _last_update_origin: string | null = null;

    constructor(path: string, serialport_factory: SerialPortFactory, shared_mode: SharedMode, logger: Logger = default_logger, txn_timeout_ms: number = 5000, snapshot_buffer_bytes: number = 65536) {
        this.path = path;
        this._shared_mode = shared_mode;
        this._logger = logger;
        this._snapshot_max_bytes = snapshot_buffer_bytes;

        this._session = new PortSession(serialport_factory, {
            on_state: (state: RemoteSerialPortState, message?: string): void => {
                for (const subscriber of this._subscribers.values()) {
                    subscriber.callbacks.on_state(state, message);
                }
            },
            on_write_ack: (): void => {
                const origin: string | null | undefined = this._pending_ack_origins.shift();
                if (origin !== undefined && origin !== null) {
                    this._subscribers.get(origin)?.callbacks.on_drain();
                }
                // After a write finishes, fifo-strict may release the in-flight slot; fifo & fifo-strict
                // both then try to dispatch the next ready entry.
                if (this._shared_mode === "fifo-strict") {
                    this._strict_in_flight = false;
                }
                if (this._shared_mode === "fifo" || this._shared_mode === "fifo-strict") {
                    this._maybe_dispatch();
                }
            },
            on_txn_timeout: (namespaced_txn_id: string, message: string): void => {
                const separator: number = namespaced_txn_id.indexOf("::");
                if (separator < 0) {
                    this._logger.warn(`SharedPortSession got non-namespaced txn timeout: ${namespaced_txn_id}`);
                    return;
                }
                const subscriber_id: string = namespaced_txn_id.slice(0, separator);
                const txn_id: string = namespaced_txn_id.slice(separator + 2);
                // Drop from schedule queue if it was waiting on `_end` (won't arrive now)
                this._drop_from_queue(namespaced_txn_id);
                this._subscribers.get(subscriber_id)?.callbacks.on_txn_timeout(txn_id, message);
            }
        }, logger, txn_timeout_ms);

        // Centralized device→client dispatcher. Replaces direct port.on("data") attachment per
        // subscriber so COW modes can intercept (echo filter / snapshot replay) without each
        // subscriber observing raw fanout.
        this._session.port.on("data", (chunk: SerialPortPacket): void => this._dispatch_data(chunk));
    }

    private _dispatch_data(chunk: SerialPortPacket): void {
        const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

        // `cow-snapshot`: append to ring buffer for replay to future subscribers. Trim from the
        // front; if the head chunk itself is too big, slice it (don't drop the whole chunk and
        // leave the buffer empty).
        if (this._shared_mode === "cow-snapshot") {
            this._snapshot_buffer.push(buf);
            this._snapshot_bytes += buf.length;
            while (this._snapshot_bytes > this._snapshot_max_bytes && this._snapshot_buffer.length > 0) {
                const head: Buffer = this._snapshot_buffer[0];
                const excess: number = this._snapshot_bytes - this._snapshot_max_bytes;
                if (head.length <= excess) {
                    this._snapshot_buffer.shift();
                    this._snapshot_bytes -= head.length;
                } else {
                    this._snapshot_buffer[0] = head.subarray(excess);
                    this._snapshot_bytes -= excess;
                    break;
                }
            }
        }

        // `cow-write-isolate`: route prefix-matching bytes to the writer only; remainder fans out.
        if (this._shared_mode === "cow-write-isolate") {
            this._fanout_with_echo_filter(buf);
            return;
        }

        // Default fanout to all subscribers.
        for (const cb of this._data_callbacks.values()) {
            cb(buf);
        }
    }

    private _fanout_with_echo_filter(chunk_in: Buffer): void {
        let remaining: Buffer = chunk_in;
        for (const id of this._subscribe_order) {
            if (remaining.length === 0) {
                break;
            }
            const queue: Buffer[] | undefined = this._pending_echo.get(id);
            if (queue === undefined || queue.length === 0) {
                continue;
            }
            const expected: Buffer = queue[0];
            const compare_len: number = Math.min(remaining.length, expected.length);
            let matched = 0;
            for (let i = 0; i < compare_len; i++) {
                if (remaining[i] === expected[i]) {
                    matched++;
                } else {
                    break;
                }
            }
            if (matched === 0) {
                continue;
            }
            const cb: ((chunk: SerialPortPacket) => void) | undefined = this._data_callbacks.get(id);
            if (cb !== undefined) {
                cb(remaining.subarray(0, matched));
            }
            remaining = remaining.subarray(matched);
            if (matched === expected.length) {
                queue.shift();
            } else {
                queue[0] = expected.subarray(matched);
            }
        }
        if (remaining.length > 0) {
            for (const cb of this._data_callbacks.values()) {
                cb(remaining);
            }
        }
    }

    /**
     * Dispatch ready entries from the head of {@link _schedule_queue} to the underlying physical port,
     * honoring `'fifo'` HOL semantics (`ready === false` at head blocks all) and `'fifo-strict'`
     * single-in-flight (one dispatch then wait for ack).
     */
    private _maybe_dispatch(): void {
        while (this._schedule_queue.length > 0) {
            const head: ScheduleEntry = this._schedule_queue[0];
            if (head.ready === false) {
                return; // HOL: a txn at the head is still buffering chunks
            }
            if (this._shared_mode === "fifo-strict" && this._strict_in_flight === true) {
                return; // stop-and-wait: another write is in flight
            }
            this._schedule_queue.shift();
            this._pending_ack_origins.push(head.subscriber_id);
            if (this._shared_mode === "fifo-strict") {
                this._strict_in_flight = true;
            }
            if (head.kind === "packet") {
                this._session.write_to_physical(head.data as SerialPortPacket);
            } else {
                this._session.txn_end(head.namespaced_txn_id as string);
            }
        }
    }

    private _drop_from_queue(namespaced_txn_id: string): void {
        const idx: number = this._schedule_queue.findIndex((e: ScheduleEntry): boolean => e.namespaced_txn_id === namespaced_txn_id);
        if (idx >= 0) {
            this._schedule_queue.splice(idx, 1);
        }
    }

    get state(): RemoteSerialPortState {
        return this._session.state;
    }

    get is_open(): boolean {
        return this._session.is_open;
    }

    get refcount(): number {
        return this._subscribers.size;
    }

    get shared_mode(): SharedMode {
        return this._shared_mode;
    }

    /** The shared `socket.port` emitter (all subscribers' `on("data")` listeners attach here). */
    get port(): AbsRemoteSerialServerSocketPort {
        return this._session.port;
    }

    subscribe(subscriber_id: string, callbacks: SubscriberCallbacks): void {
        if (this._subscribers.has(subscriber_id)) {
            return;
        }
        this._subscribers.set(subscriber_id, { id: subscriber_id, callbacks: callbacks, data_listeners: new Set() });
        this._subscribe_order.push(subscriber_id);
        if (this._shared_mode === "pipe" && this._writer_id === null) {
            this._writer_id = subscriber_id;
        }
    }

    /** Returns `true` when the last subscriber leaves (caller can destroy the session). */
    unsubscribe(subscriber_id: string): boolean {
        const subscriber: SubscriberRecord | undefined = this._subscribers.get(subscriber_id);
        if (subscriber === undefined) {
            return this._subscribers.size === 0;
        }

        // Drop the centralized data callback (port-level listener attaches happen in ctor; no need to
        // detach per-subscriber there).
        this._data_callbacks.delete(subscriber_id);
        this._pending_echo.delete(subscriber_id);
        this._subscriber_set_state.delete(subscriber_id);
        this._subscriber_update_state.delete(subscriber_id);
        subscriber.data_listeners.clear();

        const order_index: number = this._subscribe_order.indexOf(subscriber_id);
        if (order_index >= 0) {
            this._subscribe_order.splice(order_index, 1);
        }
        this._subscribers.delete(subscriber_id);

        // Pipe: writer left -> promote next earliest live subscriber
        if (this._shared_mode === "pipe" && this._writer_id === subscriber_id) {
            this._writer_id = this._subscribe_order[0] ?? null;
            if (this._writer_id !== null) {
                this._subscribers.get(this._writer_id)?.callbacks.on_writer_promoted?.();
            }
        }

        return this._subscribers.size === 0;
    }

    is_writer(subscriber_id: string): boolean {
        return this._shared_mode !== "pipe" || this._writer_id === subscriber_id;
    }

    /** Open the underlying physical port if not already open (idempotent). */
    request_open(subscriber_id: string, options: OpenSerialPortOptions): void {
        if (this._opened === true) {
            // Already open by an earlier subscriber: bring this one up to speed with the current state
            this._subscribers.get(subscriber_id)?.callbacks.on_state(this._session.state);
            return;
        }
        this._opened = true;
        this._session.open(this.path, options);
    }

    attach_data_listener(subscriber_id: string, listener: (chunk: SerialPortPacket) => void): void {
        const subscriber: SubscriberRecord | undefined = this._subscribers.get(subscriber_id);
        if (subscriber === undefined) {
            return;
        }
        subscriber.data_listeners.add(listener);

        // `cow-snapshot`: replay the ring buffer to this fresh subscriber before any live bytes flow.
        // JS is single-threaded so no live bytes can arrive between the replay loop and the callback
        // registration below.
        if (this._shared_mode === "cow-snapshot" && this._snapshot_buffer.length > 0) {
            for (const chunk of this._snapshot_buffer) {
                listener(chunk);
            }
        }

        this._data_callbacks.set(subscriber_id, listener);
    }

    /* ---- per-subscriber writes ---- */

    subscriber_write_packet(subscriber_id: string, data: SerialPortPacket): void {
        if (this.is_writer(subscriber_id) === false) {
            this._logger.debug(`pipe mode: dropping write from non-writer "${subscriber_id}" on "${this.path}"`);
            // Always ack so the client's send window does not stall, even on dropped writes
            process.nextTick((): void => this._subscribers.get(subscriber_id)?.callbacks.on_drain());
            return;
        }
        // `cow-write-isolate`: remember the bytes we're about to write so the device echo can be
        // routed back to this subscriber only.
        if (this._shared_mode === "cow-write-isolate") {
            const echo_buf: Buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
            let queue: Buffer[] | undefined = this._pending_echo.get(subscriber_id);
            if (queue === undefined) {
                queue = [];
                this._pending_echo.set(subscriber_id, queue);
            }
            queue.push(echo_buf);
        }
        if (this._shared_mode === "fifo" || this._shared_mode === "fifo-strict") {
            this._schedule_queue.push({ subscriber_id: subscriber_id, kind: "packet", data: data, namespaced_txn_id: null, ready: true });
            this._maybe_dispatch();
        } else {
            // 'batch' / 'pipe' / 'cow-*': immediate flush (Node Stream serializes byte-wise; cross-subscriber races resolve in arrival order)
            this._pending_ack_origins.push(subscriber_id);
            this._session.write_to_physical(data);
        }
    }

    subscriber_txn_begin(subscriber_id: string, txn_id: string): void {
        if (this.is_writer(subscriber_id) === false) {
            this._logger.debug(`pipe mode: dropping txn begin from non-writer "${subscriber_id}" on "${this.path}"`);
            return;
        }
        const namespaced: string = `${subscriber_id}::${txn_id}`;
        this._session.txn_begin(namespaced);
        if (this._shared_mode === "fifo" || this._shared_mode === "fifo-strict") {
            // HOL: claim a slot in begin-arrival order; not ready until `_end` arrives
            this._schedule_queue.push({ subscriber_id: subscriber_id, kind: "txn", data: null, namespaced_txn_id: namespaced, ready: false });
        }
    }

    subscriber_txn_chunk(subscriber_id: string, txn_id: string, data: SerialPortPacket): void {
        if (this.is_writer(subscriber_id) === false) {
            return;
        }
        this._session.txn_chunk(`${subscriber_id}::${txn_id}`, data);
    }

    subscriber_txn_end(subscriber_id: string, txn_id: string): void {
        if (this.is_writer(subscriber_id) === false) {
            process.nextTick((): void => this._subscribers.get(subscriber_id)?.callbacks.on_drain());
            return;
        }
        const namespaced: string = `${subscriber_id}::${txn_id}`;
        if (this._shared_mode === "fifo" || this._shared_mode === "fifo-strict") {
            // Mark the queued entry ready; head-of-line dispatch then drains in begin order
            const entry: ScheduleEntry | undefined = this._schedule_queue.find((e: ScheduleEntry): boolean => e.namespaced_txn_id === namespaced);
            if (entry === undefined) {
                // No begin entry (e.g. timed out and dropped earlier): still ack so client window doesn't stall
                process.nextTick((): void => this._subscribers.get(subscriber_id)?.callbacks.on_drain());
                return;
            }
            entry.ready = true;
            this._maybe_dispatch();
        } else {
            // 'batch' / 'pipe': flush immediately on _end arrival (no HOL across cross-subscriber txns)
            this._pending_ack_origins.push(subscriber_id);
            this._session.txn_end(namespaced);
        }
    }

    subscriber_txn_abort(subscriber_id: string, txn_id: string): void {
        if (this.is_writer(subscriber_id) === false) {
            return;
        }
        const namespaced: string = `${subscriber_id}::${txn_id}`;
        this._session.txn_abort(namespaced);
        if (this._shared_mode === "fifo" || this._shared_mode === "fifo-strict") {
            this._drop_from_queue(namespaced);
        }
    }

    subscriber_set_remote(subscriber_id: string, options: SetOptions): void {
        if (this.is_writer(subscriber_id) === false) {
            return;
        }
        // `cow-virtual-port`: record per-subscriber intent and log conflicts (last-write-wins on the
        // physical port). Subscribers that *think* they own the port can still introspect via the
        // logger or via `_subscriber_set_state` (internal — exposed only through future hooks).
        if (this._shared_mode === "cow-virtual-port") {
            const prev: SetOptions | undefined = this._subscriber_set_state.get(subscriber_id);
            this._subscriber_set_state.set(subscriber_id, options);
            if (this._last_set_origin !== null && this._last_set_origin !== subscriber_id && JSON.stringify(prev) !== JSON.stringify(options)) {
                this._logger.warn(`cow-virtual-port: set conflict on "${this.path}" — last by "${this._last_set_origin}", now overridden by "${subscriber_id}"`);
            }
            this._last_set_origin = subscriber_id;
        }
        this._session.set_remote(options);
    }

    subscriber_update_remote(subscriber_id: string, options: UpdateOptions): void {
        if (this.is_writer(subscriber_id) === false) {
            return;
        }
        if (this._shared_mode === "cow-virtual-port") {
            const prev: UpdateOptions | undefined = this._subscriber_update_state.get(subscriber_id);
            this._subscriber_update_state.set(subscriber_id, options);
            if (this._last_update_origin !== null && this._last_update_origin !== subscriber_id && JSON.stringify(prev) !== JSON.stringify(options)) {
                this._logger.warn(`cow-virtual-port: update conflict on "${this.path}" — last by "${this._last_update_origin}", now overridden by "${subscriber_id}"`);
            }
            this._last_update_origin = subscriber_id;
        }
        this._session.update_remote(options);
    }

    subscriber_flush_remote(subscriber_id: string): void {
        if (this.is_writer(subscriber_id) === false) {
            return;
        }
        this._session.flush_remote();
    }

    /** @internal Test-visible: per-subscriber `set` state in `cow-virtual-port` mode. */
    get_subscriber_set_state(subscriber_id: string): SetOptions | undefined {
        return this._subscriber_set_state.get(subscriber_id);
    }

    /** @internal Test-visible: per-subscriber `update` state in `cow-virtual-port` mode. */
    get_subscriber_update_state(subscriber_id: string): UpdateOptions | undefined {
        return this._subscriber_update_state.get(subscriber_id);
    }

    get_remote_status(): Promise<PortStatus> {
        return this._session.get_remote_status();
    }

    /** Tear down the underlying physical port (call when refcount hits 0). Also clears scheduler state. */
    destroy(): void {
        this._pending_ack_origins.length = 0;
        this._schedule_queue.length = 0;
        this._strict_in_flight = false;
        this._subscribers.clear();
        this._subscribe_order.length = 0;
        this._writer_id = null;
        this._data_callbacks.clear();
        this._pending_echo.clear();
        this._snapshot_buffer.length = 0;
        this._snapshot_bytes = 0;
        this._subscriber_set_state.clear();
        this._subscriber_update_state.clear();
        this._last_set_origin = null;
        this._last_update_origin = null;
        this._session.destroy();
    }
}

/**
 * Per-subscriber facade with the same surface as {@link PortSession}; what a `RemoteSerialServerSocket`
 * holds as its `_session` when running under `multi_access: 'shared'`.
 */
export class SharedSubscriberFacade {
    public readonly subscriber_id: string;

    private readonly _shared: SharedPortSession;

    private readonly _on_release: () => void;

    private _piped = false;

    constructor(shared: SharedPortSession, subscriber_id: string, on_release: () => void, callbacks: SubscriberCallbacks) {
        this._shared = shared;
        this.subscriber_id = subscriber_id;
        this._on_release = on_release;
        this._shared.subscribe(subscriber_id, callbacks);
    }

    get path(): string {
        return this._shared.path;
    }

    get state(): RemoteSerialPortState {
        return this._shared.state;
    }

    get is_open(): boolean {
        return this._shared.is_open;
    }

    get port(): AbsRemoteSerialServerSocketPort {
        return this._shared.port;
    }

    /** First opener on this path actually opens the physical port; later opens are no-ops. */
    open(_path: string, options: OpenSerialPortOptions): void {
        this._shared.request_open(this.subscriber_id, options);
    }

    /** In shared mode "close" from a subscriber unsubscribes; underlying port closes when refcount drops to 0. */
    close(): void {
        this._on_release();
    }

    enable_read_forwarding(on_data: (chunk: SerialPortPacket) => void): void {
        if (this._piped === true) {
            return;
        }
        this._piped = true;
        this._shared.attach_data_listener(this.subscriber_id, on_data);
    }

    write_to_physical(data: SerialPortPacket): void {
        this._shared.subscriber_write_packet(this.subscriber_id, data);
    }

    txn_begin(txn_id: string): void {
        this._shared.subscriber_txn_begin(this.subscriber_id, txn_id);
    }

    txn_chunk(txn_id: string, data: SerialPortPacket): void {
        this._shared.subscriber_txn_chunk(this.subscriber_id, txn_id, data);
    }

    txn_end(txn_id: string): void {
        this._shared.subscriber_txn_end(this.subscriber_id, txn_id);
    }

    txn_abort(txn_id: string): void {
        this._shared.subscriber_txn_abort(this.subscriber_id, txn_id);
    }

    set_remote(options: SetOptions): void {
        this._shared.subscriber_set_remote(this.subscriber_id, options);
    }

    update_remote(options: UpdateOptions): void {
        this._shared.subscriber_update_remote(this.subscriber_id, options);
    }

    flush_remote(): void {
        this._shared.subscriber_flush_remote(this.subscriber_id);
    }

    get_remote_status(): Promise<PortStatus> {
        return this._shared.get_remote_status();
    }

    /** Called on socket disconnect: unsubscribes (and closes underlying port if last). */
    destroy(): void {
        this._on_release();
    }
}

/**
 * Server-level registry of {@link SharedPortSession}s, keyed by serial port path. Used by both
 * namespace-mode and mux-mode sockets when `multi_access: 'shared'`.
 */
export class SharedSessionRegistry {
    private readonly _sessions: Map<string, SharedPortSession> = new Map();

    private readonly _serialport_factory: SerialPortFactory;

    private readonly _shared_mode: SharedMode;

    private readonly _logger: Logger;

    private readonly _txn_timeout_ms: number;

    private readonly _snapshot_buffer_bytes: number;

    constructor(serialport_factory: SerialPortFactory, shared_mode: SharedMode, logger: Logger, txn_timeout_ms: number, snapshot_buffer_bytes: number = 65536) {
        this._serialport_factory = serialport_factory;
        this._shared_mode = shared_mode;
        this._logger = logger;
        this._txn_timeout_ms = txn_timeout_ms;
        this._snapshot_buffer_bytes = snapshot_buffer_bytes;
    }

    /** Get-or-create a shared session for `path` and attach `subscriber_id`. */
    acquire(path: string, subscriber_id: string, callbacks: SubscriberCallbacks): SharedSubscriberFacade {
        let session: SharedPortSession | undefined = this._sessions.get(path);
        if (session === undefined) {
            session = new SharedPortSession(path, this._serialport_factory, this._shared_mode, this._logger, this._txn_timeout_ms, this._snapshot_buffer_bytes);
            this._sessions.set(path, session);
        }
        const captured: SharedPortSession = session;
        return new SharedSubscriberFacade(captured, subscriber_id, (): void => this._release(path, subscriber_id), callbacks);
    }

    private _release(path: string, subscriber_id: string): void {
        const session: SharedPortSession | undefined = this._sessions.get(path);
        if (session === undefined) {
            return;
        }
        const empty: boolean = session.unsubscribe(subscriber_id);
        if (empty === true) {
            session.destroy();
            this._sessions.delete(path);
        }
    }
}
