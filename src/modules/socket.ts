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
    SocketClientSideEmitChannel_SerialPortAction_SendPacket,
    SocketClientSideEmitPayload_SerialPort_SendPacket,
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

import EventEmitter from "events";


export class RemoteSerialServerSocketPortEventEmitter extends EventEmitter {
    constructor() {
        super();
    }

    /**
     * @description
     * send data chunk to the event emitter, let outside can listen the data chunk
     * @param eventName
     * @param chunk
     * @returns
     */
    emit(eventName: "data", chunk: any): boolean {
        return super.emit(eventName, chunk);
    }

    /**
     * @description
     * listen the buffer command
     * @param channel - write-command
     * @param listener
     */
    on(channel: "write-command", listener: (command: Buffer) => void): this;
    /**
     * @description
     * Read-only data chunk
     * @param channel - data
     * @param listener - data chunk
     * @returns - this
     */
    on(channel: "data", listener: (data: any) => void): this;
    on(channel: string, listener: (...args: any[]) => void): this  {
        super.on(channel, listener);
        return this;
    }

    /**
     * @description
     * listen the buffer command
     * @param channel
     * @param listener
     */
    once(channel: "write-command", listener: (command: Buffer) => void): this;

    /**
     * @description
     * Read-only data chunk
     * @param channel - data
     * @param listener - data chunk
     * @returns - this
     */
    once(channel: "data", listener: (data: any) => void): this;
    once(channel: string, listener: (...args: any[]) => void): this {
        super.once(channel, listener);
        return this;
    }

    /**
     * @description
     * Send serialport buffer command to server-side real socket
     * @param data - data chunk
     */
    write(data: Buffer): void {
        super.emit("write-command", data);
    }
}


export class RemoteSerialServerSocket extends AbsRemoteSerialServerSocket {
    protected _socket: Socket;

    /**
     * @description
     * use protected to prevent direct access, because can't ensure the port is not null
     */
    protected _port: SerialPort | SerialPortMock | null = null;

    /**
     * @description
     * an event emitter for proxy the serial port event
     */
    private readonly port_event_emitter: RemoteSerialServerSocketPortEventEmitter = new RemoteSerialServerSocketPortEventEmitter();

    /**
     * @description
     * If initial fail or port, socket error, it will be true
     */
    private is_broken_port: boolean = false;

    /**
     * @description
     * debug mode, show more information
     */
    private _debug_mode: boolean = false;

    /**
     * @description
     * package for socket.io socket, maybe use 'Proxy' in the future
     * @param socket - socket.io socket
     */
    constructor(socket: Socket) {
        super();
        this._socket = socket;

        /**
         * @description
         * If socket disconnect, release serial port resource
         */
        this._socket.once("disconnect", (reason, description) => {
            this._port?.close((close_error) => {
                if (this._debug_mode === true) {
                    console.log(close_error);
                }
                this._port?.destroy();
                this._port = null;
            });
        });

        /**
         * According to past development experience, memory leak problems may occur here, and more observation is needed.
         */
        this.once("serialport_handshake", (message) => {
            if (message.code === "serialport_handshake" && message.data !== undefined && message.data !== null && typeof message.data === "object") {
                message.data.path = this.serialport_path;
                message.data.autoOpen = false;
                this._port = new SerialPort(message.data);
                this._port.open((error) => {
                    if (error) {
                        this.emit("serialport_init_result", {
                            code: "serialport_init_result",
                            data: false,
                            message: error.message
                        });
                        this.is_broken_port = true;
                    } else {
                        this.emit("serialport_init_result", {
                            code: "serialport_init_result",
                            data: true,
                            message: "Serial Port Initialization Successful"
                        });

                        this._port?.on("data", (chunk) => {
                            this.port.emit("data", chunk);
                        });
                        this.port_event_emitter.on("write-command", (command) => {
                            this._port?.write(command);
                        });
                    }
                });
            } else {
                this.emit("serialport_init_result", {
                    code: "serialport_init_result",
                    data: false,
                    message: "Serial Port Initialization Failed, In Handshake Stage"
                });
                this.is_broken_port = true;
            }
        });

        /**
         * @description
         *
         * Send handshake signal to the client-side, let client-side know the server-side is ready to handle the client-side
         */
        this.emit("serialport_handshake", {
            code: "handshake",
            data: true,
            message: "Serial Port Handshake"
        });

    }

    /**
     * @description
     * Proxy the serial port instance, read-only data chunk
     */
    get port(): RemoteSerialServerSocketPortEventEmitter {
        return this.port_event_emitter;
    }

    /**
     * @description
     * If initial fail or port, socket error, it will be true
     */
    get is_broken(): boolean {
        return this.is_broken_port;
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

    on(channel: Extract<SocketClientSideEmitChannel, SocketClientSideEmitChannel_SerialPortAction_SendPacket>, listener: (message: SocketClientSideEmitPayload_SerialPort_SendPacket) => void): void;
    on(channel: Exclude<SocketClientSideEmitChannel, SocketClientSideEmitChannel_SerialPortAction_SendPacket>, listener: (message: Exclude<SocketClientSideEmitPayload, SocketClientSideEmitPayload_SerialPort_SendPacket>) => void): void;
    on(channel: SocketClientSideEmitChannel, listener: (message: any) => void): void {
        if (channel === "serialport_send_packet") {
            this._socket.on(channel as Extract<SocketClientSideEmitChannel, SocketClientSideEmitChannel_SerialPortAction_SendPacket>, listener as (message: Extract<SocketClientSideEmitPayload, SocketClientSideEmitPayload_SerialPort_SendPacket>) => void);
        } else {
            this._socket.on(channel as Exclude<SocketClientSideEmitChannel, SocketClientSideEmitChannel_SerialPortAction_SendPacket>, listener as (message: Exclude<SocketClientSideEmitPayload, SocketClientSideEmitPayload_SerialPort_SendPacket>) => void);
        }
    }
    once(channel: Extract<SocketClientSideEmitChannel, SocketClientSideEmitChannel_SerialPortAction_SendPacket>, listener: (message: SocketClientSideEmitPayload_SerialPort_SendPacket) => void): void;
    once(channel: Exclude<SocketClientSideEmitChannel, SocketClientSideEmitChannel_SerialPortAction_SendPacket>, listener: (message: Exclude<SocketClientSideEmitPayload, SocketClientSideEmitPayload_SerialPort_SendPacket>) => void): void;
    once(channel: SocketClientSideEmitChannel, listener: (message: any) => void): void {
        if (channel === "serialport_send_packet") {
            this._socket.once(channel as Extract<SocketClientSideEmitChannel, SocketClientSideEmitChannel_SerialPortAction_SendPacket>, listener as (message: Extract<SocketClientSideEmitPayload, SocketClientSideEmitPayload_SerialPort_SendPacket>) => void);
        } else {
            this._socket.once(channel as Exclude<SocketClientSideEmitChannel, SocketClientSideEmitChannel_SerialPortAction_SendPacket>, listener as (message: Exclude<SocketClientSideEmitPayload, SocketClientSideEmitPayload_SerialPort_SendPacket>) => void);
        }
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
