
import { Namespace, ServerOptions, Server as SocketServer, Socket } from "socket.io";
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
import { RemoteSerialServerSocketNamespace, RemoteSerialServerSocket } from "./modules/socket";
import { AbsRemoteSerialServer } from "./types/remote-serialport-types/src/remote-serial-server.model";
import { DefaultEventsMap } from "socket.io/dist/typed-events";

/**
 * @description
 * Convert Socket.io Namespace to Serial Port Path
 * @param namespace - string
 * @returns string
 */
export function namespace_convert_to_serialport_path(namespace: string): string {
    if (namespace.match(/^(\/COM)[0-9]+$/) !== null) {
        return namespace.replace("/", "");
    }
    return namespace;
}

/**
 * @description
 * After RemoteSerialportSocket Return the Serial Port Path, Validate the Serial Port Path
 * @param serialport_path - serial port path
 * @param rule - regular expression to validate the serial port path
 */
export function serialport_path_validate(serialport_path: string, rule: string | RegExp = /^(\/dev\/tty(USB|AMA|ACM)|COM)[0-9]+$/): boolean {
    if (serialport_path.match(rule) === null || serialport_path === "") {
        return false;
    }
    return true;
}

/**
 * @description
 * Remote Serial Port Server Manager, Manage If you have multiple Remote Serial Port Server
 *
 * for example, you have 2 Remote Serial Port Server, one is for the production line, another is for the testing line
 *
 * or you have 2 Remote Serial Port Server, one is for the modbus, another is for the bluetooth
 */
export class RemoteSerialportServerManager {

    constructor() {
    }
}

/**
 * @description
 * Remote Serial Port Server Class
 */
export class RemoteSerialportServer extends AbsRemoteSerialServer<RemoteSerialServerSocket, RemoteSerialServerSocketNamespace> {
    protected SERVER_PORT: number;

    /**
     * @description
     * Default RegExp for Serial Port Namespace
     *
     * because of socket.io namespace limitation, COM port must have a '/' prefix, but it will replace in serialport path binding
     * @example
     * /^(\/dev\/tty(USB|AMA|ACM)|\/COM)[0-9]+$/;
     */
    protected SERIALPORT_NAMESPACE_REGEXP: RegExp | string;

    public io: SocketServer;

    protected create_remote_serial_server_socket_namespace(namespace: Namespace<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, any>): RemoteSerialServerSocketNamespace {
        return new RemoteSerialServerSocketNamespace(namespace);
    }

    protected create_remote_serial_server_socket_port(socket: Socket): RemoteSerialServerSocket {
        return new RemoteSerialServerSocket(socket);
    }

    constructor(socket_server_options?: Partial<ServerOptions>, server_port: number = 17991, serialport_namespace_regexp: RegExp | string = /^(\/dev\/tty(USB|AMA|ACM)|\/COM)[0-9]+$/) {
        super();
        this.SERVER_PORT = server_port;
        this.SERIALPORT_NAMESPACE_REGEXP = serialport_namespace_regexp;
        this.io = new SocketServer(socket_server_options);
    }

    static serialport_path_validate(serialport_path: string, rule: string | RegExp = /^(\/dev\/tty(USB|AMA|ACM)|COM)[0-9]+$/): boolean {
        return serialport_path_validate(serialport_path, rule);
    }

}


