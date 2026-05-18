import { Server as SocketServer, Namespace, Socket, ServerOptions } from "socket.io";

import {
    AbsTransport,
    AbsTransportEndpoint,
    AbsTransportServer,
    TransportAckCallback,
    TransportLifecycleEvent,
    TransportMessageListener
} from "../types/remote-serialport-types/src/transport";

/**
 * Adapts a socket.io {@link Socket} (server-side, one accepted connection) to the
 * {@link AbsTransport} interface used by the server logic.
 *
 * Channel `on` listeners are passed through verbatim — socket.io already calls them as
 * `(payload, ack?)` when the peer sent the message with an ack callback, which matches
 * {@link TransportMessageListener}.
 */
export class SocketIoServerTransport extends AbsTransport {
    private readonly _socket: Socket;

    constructor(socket: Socket) {
        super();
        this._socket = socket;
    }

    /** Underlying socket.io socket. Concrete code that genuinely needs `.nsp` etc. can reach in here. */
    get raw_socket(): Socket {
        return this._socket;
    }

    get id(): string {
        return this._socket.id;
    }

    get is_connected(): boolean {
        return this._socket.connected;
    }

    get endpoint_label(): string {
        return this._socket.nsp.name;
    }

    get credential(): unknown {
        // socket.io populates `handshake.auth` from the client's `Manager({auth: ...})` field.
        const auth: unknown = (this._socket.handshake as { auth?: unknown }).auth;
        if (auth !== null && typeof auth === "object" && Object.keys(auth as object).length === 0) {
            return undefined;
        }
        return auth;
    }

    send(channel: string, payload?: unknown): void {
        if (arguments.length < 2) {
            this._socket.emit(channel);
        } else {
            this._socket.emit(channel, payload);
        }
    }

    send_rpc(channel: string, payload: unknown, timeout_ms: number): Promise<unknown> {
        return new Promise<unknown>((resolve, reject): void => {
            let settled = false;
            const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
                if (settled === true) {
                    return;
                }
                settled = true;
                reject(new Error(`socket.io RPC "${channel}" timed out after ${timeout_ms}ms`));
            }, timeout_ms);
            this._socket.emit(channel, payload, (response: unknown): void => {
                if (settled === true) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                resolve(response);
            });
        });
    }

    on(channel: string, listener: TransportMessageListener): void {
        this._socket.on(channel, listener as (...args: any[]) => void);
    }

    once(channel: string, listener: TransportMessageListener): void {
        this._socket.once(channel, listener as (...args: any[]) => void);
    }

    off(channel: string, listener?: TransportMessageListener): void {
        if (listener === undefined) {
            this._socket.removeAllListeners(channel);
        } else {
            this._socket.off(channel, listener as (...args: any[]) => void);
        }
    }

    on_lifecycle(event: TransportLifecycleEvent, listener: (...args: any[]) => void): void {
        if (event === "connect") {
            // socket.io's server-side `Socket` is already connected when we wrap it; fire on next tick
            // so subscribers can observe the event.
            if (this._socket.connected === true) {
                process.nextTick((): void => listener());
            }
            return;
        }
        if (event === "reconnect") {
            // Server-side socket.io does not reconnect; a new Socket is created on the next session.
            return;
        }
        this._socket.on(event, listener);
    }

    off_lifecycle(event: TransportLifecycleEvent, listener: (...args: any[]) => void): void {
        if (event === "connect" || event === "reconnect") {
            return;
        }
        this._socket.off(event, listener);
    }

    /**
     * Server side wire-level backpressure probe: socket.io's ws-engine transport exposes
     * `bufferedAmount` on its underlying ws socket. Other engine transports (polling, webtransport)
     * may not — in which case `0` is returned (best-effort).
     */
    get_buffered_amount(): number | null {
        const probe: { conn?: { transport?: { socket?: { bufferedAmount?: number } } } } = this._socket as unknown as { conn?: { transport?: { socket?: { bufferedAmount?: number } } } };
        const buffered: number | undefined = probe.conn?.transport?.socket?.bufferedAmount;
        if (typeof buffered !== "number") {
            return 0;
        }
        return buffered;
    }

    close(): void {
        this._socket.disconnect();
    }
}

/**
 * Adapts a socket.io {@link Namespace} to {@link AbsTransportEndpoint}.
 */
export class SocketIoServerEndpoint extends AbsTransportEndpoint {
    private readonly _namespace: Namespace;
    private readonly _label: string | RegExp;
    private readonly _transports: Map<string, SocketIoServerTransport> = new Map();

    constructor(namespace: Namespace, label: string | RegExp) {
        super();
        this._namespace = namespace;
        this._label = label;
    }

    /** Underlying socket.io namespace. Exposed for cases that need it (e.g. `serverSideEmit`). */
    get raw_namespace(): Namespace {
        return this._namespace;
    }

    get label(): string | RegExp {
        return this._label;
    }

    on_connection(listener: (transport: AbsTransport) => void): void {
        this._namespace.on("connection", (socket: Socket): void => {
            const transport: SocketIoServerTransport = new SocketIoServerTransport(socket);
            this._transports.set(socket.id, transport);
            socket.once("disconnect", (): void => {
                this._transports.delete(socket.id);
            });
            listener(transport);
        });
    }

    close_all(): void {
        for (const transport of this._transports.values()) {
            transport.close();
        }
        this._transports.clear();
    }
}

/**
 * Adapts a socket.io {@link SocketServer} to {@link AbsTransportServer}.
 *
 * Endpoints are cached by their stringified label so `of(x)` twice returns the same endpoint
 * instance — matching socket.io's own `io.of` behavior.
 */
export class SocketIoServer extends AbsTransportServer {
    public readonly io: SocketServer;
    private readonly _endpoints: Map<string, SocketIoServerEndpoint> = new Map();

    constructor(socket_server_options?: Partial<ServerOptions>) {
        super();
        this.io = new SocketServer(socket_server_options);
    }

    listen(port?: number): void {
        if (typeof port === "number") {
            this.io.listen(port);
        }
    }

    of(label: string | RegExp): AbsTransportEndpoint {
        const key: string = typeof label === "string" ? label : label.toString();
        const existing: SocketIoServerEndpoint | undefined = this._endpoints.get(key);
        if (existing !== undefined) {
            return existing;
        }
        const namespace: Namespace = this.io.of(label);
        const endpoint: SocketIoServerEndpoint = new SocketIoServerEndpoint(namespace, label);
        this._endpoints.set(key, endpoint);
        return endpoint;
    }

    close(): void {
        for (const endpoint of this._endpoints.values()) {
            endpoint.close_all();
        }
        this._endpoints.clear();
        this.io.close();
    }
}
