import { AbsRemoteSerialServer, AbsRemoteSerialServerSocket, AbsRemoteSerialServerSocketNamespace } from "../types/remote-serialport-types/src/remote-serial-server.model";
import { SocketServerSideEmitChannel,
    SocketServerSideEmitPayloadCode,
    SocketClientSideEmitPayloadType,
    SocketServerSideEmitPayloadType,
    SocketClientSideEmitPayloadCode,
    SocketClientSideEmitChannel,
    SocketIONamespaceOnEvent } from "../types/remote-serialport-types/src/index";
import { Socket, Namespace } from "socket.io";


export class RemoteSerialServerSocket extends AbsRemoteSerialServerSocket {
    protected _socket: Socket;

    /**
     * @description
     * package for socket.io socket, maybe use 'Proxy' in the future
     * @param socket - socket.io socket
     */
    constructor(socket: Socket) {
        super();
        this._socket = socket;
    }
    emit(channel: "serialport_event", message: Extract<SocketServerSideEmitPayloadCode, "serialport_close" | "serialport_open">): void;
    emit(channel: "serialport_result", message: Extract<SocketServerSideEmitPayloadCode, "serialport_not_found" | "serialport_found">): void;
    emit(channel: "serialport_action", message: Extract<SocketServerSideEmitPayloadCode, "serialport_packet">): void;
    emit(channel: "serialport_packet", message: Buffer | ArrayBuffer | Array<number>): void;
    emit(channel: SocketServerSideEmitChannel, message: SocketServerSideEmitPayloadType): void {
        this._socket.emit(channel, message);
    }

    on(channel: SocketClientSideEmitChannel, listener: (message: SocketClientSideEmitPayloadType) => void): void {
        this._socket.on(channel, listener);
    }

    once(channel: SocketClientSideEmitChannel, listener: (message: SocketClientSideEmitPayloadType) => void): void {
        this._socket.once(channel, listener);
    }

    disconnect(close?: boolean | undefined): void {
        this._socket.disconnect(close);
    }
}

export class RemoteSerialServerSocketNamespace extends AbsRemoteSerialServerSocketNamespace<RemoteSerialServerSocket> {
    protected _namespace: Namespace;

    /**
     * @description
     * package for socket.io namespace, maybe use 'Proxy' in the future
     * @param namespace - socket.io namespace
     */
    constructor(namespace: Namespace) {
        super();
        this._namespace = namespace;
    }

    on(channel: SocketIONamespaceOnEvent, listener: (socket: RemoteSerialServerSocket) => void): void {
        this._namespace.on(channel, listener);
    }
}
