import { AbsRemoteSerialServer, AbsRemoteSerialServerSocket, AbsRemoteSerialServerSocketNamespace } from "../types/remote-serialport-types/src/remote-serial-server.model";
import { SocketServerSideEmitChannel,
    SocketServerSideEmitPayload,
    SocketClientSideEmitPayload,
    SocketClientSideEmitChannel,
    SocketIONamespaceOnEvent } from "../types/remote-serialport-types/src/index";
import { Socket, Namespace } from "socket.io";

import { SerialPort,
    ByteLengthParser,
    CCTalkParser,
    InterByteTimeoutParser,
    PacketLengthParser,
    ReadlineParser,
    ReadyParser,
    RegexParser,
    SlipEncoder,
    SpacePacketParser,
    SerialPortMock,
    SerialPortMockOpenOptions,
    SerialPortOpenOptions,
    DelimiterParser } from "serialport";


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
    /**
     * Server-side emit to client-side
     *
     * serialport_event indicates an event from the serial port, like `handshake`, `open`, `close`, `error`, `waiting`, etc.
     */
    emit(channel: "serialport_event", message: SocketServerSideEmitPayload): void;

    /**
     * Server-side emit to client-side
     *
     * serialport_result indicates the result of an action from the server.
     *
     * e.g. If Client-side want to Extract and Transmit the serial port data, when the server-side finish the action, it will emit this channel.
     */
    emit(channel: "serialport_result", message: SocketServerSideEmitPayload): void;

    /**
     * Server-side emit to client-side
     *
     * serialport_action indicates an action from the server, like `open`, `close`, `send`, etc.
     *
     * e.g. If Server-side want control the serial port, it will emit this channel.
     */
    emit(channel: "serialport_action", message: SocketServerSideEmitPayload): void;

    /**
     * Server-side emit to client-side
     *
     * serialport_packet indicates the serialport buffer packet from the serial port.
     *
     * It is an one-way transmission from server-side to client-side.
     */
    emit(channel: "serialport_packet", message: SocketServerSideEmitPayload): void;
    emit(channel: SocketServerSideEmitChannel, message: SocketServerSideEmitPayload): void {
        this._socket.emit(channel, message);
    }

    on(channel: SocketClientSideEmitChannel, listener: (message: SocketClientSideEmitPayload) => void): void {
        this._socket.on(channel, listener);
    }

    once(channel: SocketClientSideEmitChannel, listener: (message: SocketClientSideEmitPayload) => void): void {
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
        this._namespace.on<SocketIONamespaceOnEvent>(channel, (socket: Socket): void => {
            listener(new RemoteSerialServerSocket(socket));
        });
    }
}
