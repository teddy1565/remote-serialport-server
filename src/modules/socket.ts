import { AbsRemoteSerialServer, AbsRemoteSerialServerSocket, AbsRemoteSerialServerSocketNamespace } from "../types/remote-serialport-types/src/remote-serial-server.model";
import { SocketServerSideEmitChannel,
    SocketServerSideEmitPayload,
    SocketServerSideEmitPayload_SerialPort_Open,
    SocketServerSideEmitPayload_SerialPort_Close,
    SocketServerSideEmitPayload_SerialPort_Packet,
    SocketServerSideEmitPayload_SerialPort_Error,
    SocketServerSideEmitPayload_SerialPort_Found,
    SocketServerSideEmitPayload_SerialPort_NotFound,
    SocketServerSideEmitPayload_RemoteSerialServerHandshake,
    SocketServerSideEmitPayload_SerialPort_InitResult,
    SocketClientSideEmitPayload,
    SocketClientSideEmitChannel,
    SocketClientSideEmitPayload_SerialPort_Handshake,
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

    public port: SerialPort | SerialPortMock | null = null;
    /**
     * @description
     * package for socket.io socket, maybe use 'Proxy' in the future
     * @param socket - socket.io socket
     */
    constructor(socket: Socket) {
        super();
        this._socket = socket;

        /**
         * According to past development experience, memory leak problems may occur here, and more observation is needed.
         */
        this.once("serialport_handshake", (message) => {
            if (message.code === "serialport_handshake" && message.data !== undefined && message.data !== null && typeof message.data === "object") {
                message.data.path = this.serialport_path;
                message.data.autoOpen = false;
                this.port = new SerialPort(message.data);
                this.port.open((error) => {
                    if (error) {
                        this.emit("serialport_init_result", {
                            code: "serialport_init_result",
                            data: false,
                            message: error.message
                        });
                    } else {
                        this.emit("serialport_init_result", {
                            code: "serialport_init_result",
                            data: true,
                            message: "Serial Port Initialization Successful"
                        });
                    }
                });
            } else {
                this.emit("serialport_init_result", {
                    code: "serialport_init_result",
                    data: false,
                    message: "Serial Port Initialization Failed, In Handshake Stage"
                });
            }
        });

        this.emit("serialport_handshake", {
            code: "handshake",
            data: true,
            message: "Serial Port Handshake"
        });

    }
    /**
     * Server-side emit to client-side
     *
     * serialport_event indicates an event from the serial port, like `handshake`, `open`, `close`, `error`, `waiting`, etc.
     */
    emit(channel: "serialport_event", message: SocketServerSideEmitPayload & (SocketServerSideEmitPayload_SerialPort_Found | SocketServerSideEmitPayload_SerialPort_NotFound | SocketServerSideEmitPayload_SerialPort_Error)): void;

    /**
     * Server-side emit to client-side
     *
     * serialport_result indicates the result of an action from the server.
     *
     * e.g. If Client-side want to Extract and Transmit the serial port data, when the server-side finish the action, it will emit this channel.
     */
    emit(channel: "serialport_result", message: SocketServerSideEmitPayload & (SocketServerSideEmitPayload_SerialPort_Open | SocketServerSideEmitPayload_SerialPort_Close)): void;

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
    emit(channel: "serialport_packet", message: SocketServerSideEmitPayload & SocketServerSideEmitPayload_SerialPort_Packet): void;

    /**
     * When the server-side is ready to handle the client-side, it will emit this channel.
     * @param channel
     * @param message
     */
    emit(channel: "serialport_handshake", message: SocketServerSideEmitPayload & SocketServerSideEmitPayload_RemoteSerialServerHandshake): void;

    /**
     * When Handshake is done, the server-side will emit this channel to indicate the initialization result.
     * @param channel
     * @param message
     */
    emit(channel: "serialport_init_result", message: SocketServerSideEmitPayload & SocketServerSideEmitPayload_SerialPort_InitResult): void;
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
