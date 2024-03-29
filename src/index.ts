
import { Namespace, ServerOptions, Server as SocketServer, Socket } from "socket.io";
import { SerialPort } from "serialport";
import { RemoteSerialServerSocketNamespace, RemoteSerialServerSocket } from "./modules/socket";
import { AbsRemoteSerialServer } from "./types/remote-serialport-types/src/remote-serial-server.model";
import { DefaultEventsMap } from "socket.io/dist/typed-events";

function namespace_convert_to_serialport_path(namespace: string): string {
    if (namespace.match(/^(\/COM)[0-9]+$/) !== null) {
        return namespace.replace("/", "");
    }
    return namespace;
}

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

}


// public start(): void {
//     this.io.listen(this.SERVER_PORT);
//     console.log(`Socket Server Listening on Port ${this.SERVER_PORT}`);

//     this.io.of(this.SERIALPORT_NAMESPACE_REGEXP).on("connection", async (socket) => {
//         const select_serialport_path = namespace_convert_to_serialport_path(socket.nsp.name);

//         console.log(`Socket Connected to Server on Port ${this.SERVER_PORT}, of: ${socket.nsp.name}`);

//         socket.on("disconnect", () => {
//             console.log("Socket Disconnected");
//         });

//         try {
//             const serialport_list = await SerialPort.list();
//             const selected_serialport = serialport_list.find((serialport) => serialport.path === select_serialport_path);
//             if (selected_serialport === undefined) {
//                 socket.emit("")
//                 throw new Error(`Serial Port ${select_serialport_path} Not Found`);
//             }
//             const serialport = new SerialPort({
//                 path: selected_serialport.path,
//                 baudRate: 9600
//             });
//             this.serialport_map.set(select_serialport_path, serialport);
//         } catch (error) {
//             console.log(error);
//             return socket.disconnect();
//         }
//     });
// }
