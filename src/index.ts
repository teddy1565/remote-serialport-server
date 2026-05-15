import { ServerOptions, Server as SocketServer } from "socket.io";

import {
    RemoteSerialServerSocket,
    RemoteSerialServerSocketNamespace,
    RemoteSerialServerMuxSocket,
    RemoteSerialServerMuxSocketNamespace,
    default_serialport_factory,
    default_serialport_list_provider
} from "./modules/socket";
import { SocketIoServer } from "./modules/socketio-transport";
import { default_logger } from "./modules/logger";
import { SharedSessionRegistry, SharedMode } from "./modules/shared-session";
import { AbsRemoteSerialServer, RemoteSerialServerOptions, AuthValidator, RemoteSerialServerAcl } from "./types/remote-serialport-types/src/remote-serial-server.model";
import { AbsTransport, AbsTransportEndpoint, AbsTransportServer } from "./types/remote-serialport-types/src/transport";
import { SerialPortFactory, SerialPortListProvider } from "./types/remote-serialport-types/src/serialport";
import { Logger } from "./types/remote-serialport-types/src/logger";

/**
 * Default regexp for serial-port-like socket.io namespaces.
 *
 * Because of socket.io namespace rules a Windows COM port must be prefixed with `/` (e.g. `/COM5`);
 * the prefix is stripped when binding the real serial path.
 */
export const DEFAULT_SERIALPORT_NAMESPACE_REGEXP: RegExp = /^(\/dev\/tty(USB|AMA|ACM)|\/COM)[0-9]+$/;

/**
 * Default mux-mode namespace.
 */
export const DEFAULT_MUX_NAMESPACE = "/";

/**
 * Convert a socket.io namespace to a serial port path (strips the leading `/` for `/COM*`).
 */
export function namespace_convert_to_serialport_path(namespace: string): string {
    if (namespace.match(/^(\/COM)[0-9]+$/) !== null) {
        return namespace.replace("/", "");
    }
    return namespace;
}

/**
 * Validate a serial port path against `rule`.
 */
export function serialport_path_validate(serialport_path: string, rule: string | RegExp = /^(\/dev\/tty(USB|AMA|ACM)|COM)[0-9]+$/): boolean {
    if (serialport_path === "" || serialport_path.match(rule) === null) {
        return false;
    }
    return true;
}

/**
 * Construction options for {@link RemoteSerialportServer}.
 */
export interface RemoteSerialportServerConstructorOptions extends RemoteSerialServerOptions {
    /** Regexp matched against serial-port-like namespaces. Defaults to {@link DEFAULT_SERIALPORT_NAMESPACE_REGEXP}. */
    serialport_namespace_regexp?: RegExp | string;
    /** Factory for the physical serial port. Defaults to `(options) => new SerialPort(options)`. Inject a mock in tests. */
    serialport_factory?: SerialPortFactory;
    /** Provider for the `serialport_list` RPC. Defaults to `() => SerialPort.list()`. Inject a custom one in tests. */
    port_list_provider?: SerialPortListProvider;
    /**
     * Inject a custom transport server (e.g. {@link NodeIpcServer}). If unset, the server is
     * backed by {@link SocketIoServer} constructed from `socket_server_options`.
     */
    transport_server?: AbsTransportServer;
}

/**
 * Registry for managing several {@link RemoteSerialportServer} instances under string keys —
 * e.g. one per production line, or one for Modbus and one for Bluetooth.
 */
export class RemoteSerialportServerManager {
    private readonly _servers: Map<string, RemoteSerialportServer> = new Map();

    constructor() {
        // nothing to set up
    }

    /** Register an existing server under `key`. Throws if `key` is already taken. */
    register(key: string, server: RemoteSerialportServer): this {
        if (this._servers.has(key)) {
            throw new Error(`RemoteSerialportServerManager: key "${key}" is already registered`);
        }
        this._servers.set(key, server);
        return this;
    }

    /** Construct a new {@link RemoteSerialportServer}, register it under `key`, and return it. */
    create(key: string, socket_server_options?: Partial<ServerOptions>, server_port?: number, options?: RemoteSerialportServerConstructorOptions): RemoteSerialportServer {
        const server: RemoteSerialportServer = new RemoteSerialportServer(socket_server_options, server_port, options);
        this.register(key, server);
        return server;
    }

    get(key: string): RemoteSerialportServer | undefined {
        return this._servers.get(key);
    }

    has(key: string): boolean {
        return this._servers.has(key);
    }

    /** Remove the server registered under `key` (does not close it). Returns whether it existed. */
    unregister(key: string): boolean {
        return this._servers.delete(key);
    }

    /** All registered servers, keyed by their registration key. */
    get servers(): ReadonlyMap<string, RemoteSerialportServer> {
        return this._servers;
    }

    /** `listen()` every registered server. */
    listen_all(): void {
        for (const server of this._servers.values()) {
            server.listen();
        }
    }

    /** Close every registered server's underlying transport (best effort). */
    close_all(): void {
        for (const server of this._servers.values()) {
            try {
                server.close();
            } catch {
                // ignore
            }
        }
    }
}

/**
 * Remote serial port server.
 *
 * - `of(namespace)` — namespace mode: one remote serial port per connection (the namespace names it).
 * - `mux(namespace)` — mux mode: many remote ports per connection, addressed dynamically by `path`.
 *
 * Multiple namespaces are multiplexed over each client's single transport connection (socket.io
 * namespaces), so a client can talk to many ports over one connection in either mode.
 */
export class RemoteSerialportServer extends AbsRemoteSerialServer<
    RemoteSerialServerSocket,
    RemoteSerialServerSocketNamespace,
    RemoteSerialServerMuxSocket,
    RemoteSerialServerMuxSocketNamespace
> {
    protected readonly SERVER_PORT: number;

    protected readonly SERIALPORT_NAMESPACE_REGEXP: RegExp | string;

    protected readonly _transport_server: AbsTransportServer;

    protected readonly strict_path: boolean;

    protected readonly auto_pipe: boolean;

    private readonly _serialport_factory: SerialPortFactory;

    private readonly _port_list_provider: SerialPortListProvider;

    private readonly _logger: Logger;

    private readonly _txn_timeout_ms: number;

    private readonly _txn_timeout_action: "log" | "state" | "both";

    private readonly _auth_validator: AuthValidator | null;

    private readonly _acl: RemoteSerialServerAcl | null;

    /** Set only when `multi_access: 'shared'`; per-path shared sessions across all sockets. */
    private readonly _shared_registry: SharedSessionRegistry | null;

    /** Wrapped server sockets, keyed by transport.id (so the same connection maps to the same instance). */
    private readonly socket_map: Map<string, RemoteSerialServerSocket> = new Map();

    /** Wrapped namespaces, keyed by the underlying endpoint instance (same endpoint -> same wrapper). */
    private readonly namespace_map: Map<AbsTransportEndpoint, RemoteSerialServerSocketNamespace> = new Map();

    /** Wrapped mux sockets, keyed by transport.id. */
    private readonly mux_socket_map: Map<string, RemoteSerialServerMuxSocket> = new Map();

    /** Wrapped mux namespaces, keyed by the underlying endpoint instance. */
    private readonly mux_namespace_map: Map<AbsTransportEndpoint, RemoteSerialServerMuxSocketNamespace> = new Map();

    /** Incremented every time a wrapped namespace receives an `on("connection", ...)` registration.
     *  Used by {@link listen} to warn if the user forgot to register a listener (a common mistake
     *  even with `auto_pipe: true` — without an `on("connection")` call, the underlying socket.io
     *  namespace's `connection` handler is never wired and no `RemoteSerialServerSocket` wrappers
     *  are instantiated, so the server silently accepts TCP but does nothing). */
    private _connection_listener_count = 0;

    /** Set to `true` while {@link listen} is scheduling its post-listen sanity check so we don't
     *  schedule duplicates on repeated `listen()` calls. */
    private _post_listen_check_scheduled = false;

    constructor(socket_server_options?: Partial<ServerOptions>, server_port: number = 17991, options: RemoteSerialportServerConstructorOptions = {}) {
        super();
        this.SERVER_PORT = server_port;
        this.SERIALPORT_NAMESPACE_REGEXP = options.serialport_namespace_regexp ?? DEFAULT_SERIALPORT_NAMESPACE_REGEXP;
        this.strict_path = options.strict_path ?? true;
        this.auto_pipe = options.auto_pipe ?? false;
        this._serialport_factory = options.serialport_factory ?? default_serialport_factory;
        this._port_list_provider = options.port_list_provider ?? default_serialport_list_provider;
        this._logger = options.logger ?? default_logger;
        this._txn_timeout_ms = options.txn_timeout_ms ?? 5000;
        this._txn_timeout_action = options.txn_timeout_action ?? "log";
        this._auth_validator = options.auth_validator ?? null;
        this._acl = options.acl ?? null;
        const multi_access = options.multi_access ?? "reject";
        const shared_mode: SharedMode = options.shared_mode ?? "fifo";
        const cow_snapshot_buffer_bytes: number = options.cow_snapshot_buffer_bytes ?? 65536;
        this._shared_registry = multi_access === "shared" ? new SharedSessionRegistry(this._serialport_factory, shared_mode, this._logger, this._txn_timeout_ms, cow_snapshot_buffer_bytes) : null;
        this._transport_server = options.transport_server ?? new SocketIoServer(socket_server_options);
    }

    /**
     * Underlying socket.io server (only available when running on the default socket.io transport).
     * Provided for ecosystem code that needs to reach into socket.io directly (`io.close()`, custom
     * middleware, etc.).
     */
    public get io(): SocketServer {
        return (this._transport_server as SocketIoServer).io;
    }

    protected create_remote_serial_server_socket_port(transport: AbsTransport): RemoteSerialServerSocket {
        const existing: RemoteSerialServerSocket | undefined = this.socket_map.get(transport.id);
        if (existing !== undefined) {
            return existing;
        }
        const instance: RemoteSerialServerSocket = new RemoteSerialServerSocket(transport, {
            serialport_factory: this._serialport_factory,
            strict_path: this.strict_path,
            port_list_provider: this._port_list_provider,
            logger: this._logger,
            txn_timeout_ms: this._txn_timeout_ms,
            txn_timeout_action: this._txn_timeout_action,
            shared_registry: this._shared_registry,
            auth_validator: this._auth_validator,
            acl: this._acl,
            auto_pipe: this.auto_pipe
        });
        this.socket_map.set(transport.id, instance);
        transport.on_lifecycle("disconnect", (): void => {
            this.socket_map.delete(transport.id);
        });
        return instance;
    }

    protected create_remote_serial_server_socket_namespace(endpoint: AbsTransportEndpoint): RemoteSerialServerSocketNamespace {
        const existing: RemoteSerialServerSocketNamespace | undefined = this.namespace_map.get(endpoint);
        if (existing !== undefined) {
            return existing;
        }
        const instance: RemoteSerialServerSocketNamespace = new RemoteSerialServerSocketNamespace(
            endpoint,
            (transport: AbsTransport): RemoteSerialServerSocket => this.create_remote_serial_server_socket_port(transport),
            (): void => this._register_connection_listener()
        );
        this.namespace_map.set(endpoint, instance);
        return instance;
    }

    protected create_remote_serial_server_mux_socket(transport: AbsTransport): RemoteSerialServerMuxSocket {
        const existing: RemoteSerialServerMuxSocket | undefined = this.mux_socket_map.get(transport.id);
        if (existing !== undefined) {
            return existing;
        }
        const instance: RemoteSerialServerMuxSocket = new RemoteSerialServerMuxSocket(transport, {
            serialport_factory: this._serialport_factory,
            strict_path: this.strict_path,
            port_list_provider: this._port_list_provider,
            logger: this._logger,
            txn_timeout_ms: this._txn_timeout_ms,
            txn_timeout_action: this._txn_timeout_action,
            shared_registry: this._shared_registry,
            auth_validator: this._auth_validator,
            acl: this._acl,
            auto_pipe: this.auto_pipe
        });
        this.mux_socket_map.set(transport.id, instance);
        transport.on_lifecycle("disconnect", (): void => {
            this.mux_socket_map.delete(transport.id);
        });
        return instance;
    }

    protected create_remote_serial_server_mux_socket_namespace(endpoint: AbsTransportEndpoint): RemoteSerialServerMuxSocketNamespace {
        const existing: RemoteSerialServerMuxSocketNamespace | undefined = this.mux_namespace_map.get(endpoint);
        if (existing !== undefined) {
            return existing;
        }
        const instance: RemoteSerialServerMuxSocketNamespace = new RemoteSerialServerMuxSocketNamespace(
            endpoint,
            (transport: AbsTransport): RemoteSerialServerMuxSocket => this.create_remote_serial_server_mux_socket(transport),
            (): void => this._register_connection_listener()
        );
        this.mux_namespace_map.set(endpoint, instance);
        return instance;
    }

    /** @internal Invoked by wrapped namespaces when the user calls `.on("connection", listener)`. */
    private _register_connection_listener(): void {
        this._connection_listener_count += 1;
    }

    /**
     * Start the underlying transport server listening. Schedules a one-shot post-listen sanity
     * check: if 1.5 seconds pass without any `server.of(...).on("connection", ...)` or
     * `server.mux(...).on("connection", ...)` registration, emits a `warn` log explaining the
     * common pitfall. The timer is unref'd so it never keeps the process alive.
     */
    public override listen(serverport: number = this.SERVER_PORT): void {
        super.listen(serverport);
        if (this._post_listen_check_scheduled === true) {
            return;
        }
        this._post_listen_check_scheduled = true;
        const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
            if (this._connection_listener_count === 0) {
                this._logger.warn(
                    "no `server.of(...).on(\"connection\", ...)` (or `server.mux(...).on(\"connection\", ...)`) " +
                    "listener has been registered. The underlying transport's `connection` event is " +
                    "wired ONLY when you call `.on(\"connection\", ...)` on a namespace wrapper, so " +
                    "without it the server silently accepts incoming transports but never instantiates " +
                    "`RemoteSerialServerSocket` — auth, ACL, `auto_pipe`, and port routing do not " +
                    "run. (If you intentionally have no namespace handler — e.g. you only registered " +
                    "via `server.io.of(...)` raw — you can ignore this warning.) " +
                    "See the server README \"Namespace mode\" minimal example."
                );
            }
        }, 1500);
        // Don't keep the event loop alive just for this check.
        if (typeof (timer as { unref?: () => void }).unref === "function") {
            (timer as { unref: () => void }).unref();
        }
    }

    /**
     * Close the underlying transport server (and all per-connection transports it owns). Use this
     * for graceful shutdown across transports — it works for both socket.io and IPC.
     */
    public close(): void {
        this._transport_server.close();
    }

    /**
     * Validate a serial port path against `rule`. Convenience wrapper around {@link serialport_path_validate}.
     */
    static serialport_path_validate(serialport_path: string, rule: string | RegExp = /^(\/dev\/tty(USB|AMA|ACM)|COM)[0-9]+$/): boolean {
        return serialport_path_validate(serialport_path, rule);
    }
}

/* ---- transport re-exports ---- */
export { SocketIoServer, SocketIoServerEndpoint, SocketIoServerTransport } from "./modules/socketio-transport";
export { NodeIpcServer, NodeIpcServerEndpoint, NodeIpcServerTransport, MessagePortLike } from "./modules/ipc-transport";
export type { AbsTransport, AbsTransportEndpoint, AbsTransportServer } from "./types/remote-serialport-types/src/transport";
