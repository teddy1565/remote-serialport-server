
import { Namespace, ServerOptions, Server as SocketServer, Socket } from "socket.io";

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
    protected readonly SERVER_PORT: number;

    /**
     * @description
     * Default RegExp for Serial Port Namespace
     *
     * because of socket.io namespace limitation, COM port must have a '/' prefix, but it will replace in serialport path binding
     * @example
     * /^(\/dev\/tty(USB|AMA|ACM)|\/COM)[0-9]+$/;
     */
    protected readonly SERIALPORT_NAMESPACE_REGEXP: RegExp | string;

    public readonly io: SocketServer;

    /**
     * @description
     * Map for Remote Serial Server Socket instance, key is socket id.
     */
    private readonly socket_map: Map<string, RemoteSerialServerSocket> = new Map();

    /**
     * @description
     * Map for Remote Serial Server Socket Namespace instance, key is namespace.
     *
     * The main purpose of the current design is to reduce memory usage and allow the same namespace to access the same instance.
     */
    private readonly namespace_map: Map<string, RemoteSerialServerSocketNamespace> = new Map();

    protected create_remote_serial_server_socket_namespace(namespace: Namespace<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, any>): RemoteSerialServerSocketNamespace {
        if (this.namespace_map.has(namespace.name)) {
            return this.namespace_map.get(namespace.name) as RemoteSerialServerSocketNamespace;
        }

        const remote_serial_server_namespce_instance = new RemoteSerialServerSocketNamespace(namespace);
        this.namespace_map.set(namespace.name, remote_serial_server_namespce_instance);

        return remote_serial_server_namespce_instance;
    }

    protected create_remote_serial_server_socket_port(socket: Socket): RemoteSerialServerSocket {
        if (this.socket_map.has(socket.id)) {
            return this.socket_map.get(socket.id) as RemoteSerialServerSocket;
        }

        const remote_serial_server_socket_instance = new RemoteSerialServerSocket(socket);
        this.socket_map.set(socket.id, remote_serial_server_socket_instance);
        return remote_serial_server_socket_instance;
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


