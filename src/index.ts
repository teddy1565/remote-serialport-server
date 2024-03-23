
import { ServerOptions, Server as SocketServer } from "socket.io";
import { SerialPort } from "serialport";
import { IRemoteSerialportServer } from "./index.d";

export class RemoteSerialportServer implements IRemoteSerialportServer {
    public SERVER_PORT: number;
    public SERIALPORT_NAMESPACE_REGEXP: RegExp | string;

    private serialport_map: Map<string, SerialPort> = new Map();

    private io: SocketServer;
    private io_server_options?: Partial<ServerOptions>;

    constructor(socket_server_options?: Partial<ServerOptions>, server_port: number = 17991, serialport_namespace_regexp: RegExp | string = /^(\/dev\/tty(USB|AMA|ACM)|COM)[0-9]+$/) {
        this.SERVER_PORT = server_port;
        this.SERIALPORT_NAMESPACE_REGEXP = serialport_namespace_regexp;
        this.io_server_options = socket_server_options;
        this.io = new SocketServer(socket_server_options);
    }

    start(): void {
        this.io.listen(this.SERVER_PORT);
        console.log(`Socket Server Listening on Port ${this.SERVER_PORT}`);

        this.io.of(this.SERIALPORT_NAMESPACE_REGEXP).on("connection", async (socket) => {
            const select_serialport_path = socket.nsp.name;
            console.log(`Socket Connected to Server on Port ${this.SERVER_PORT}, of: ${socket.nsp.name}`);
            socket.on("disconnect", () => {
                console.log("Socket Disconnected");
            });

            try {
                const serialport_list = await SerialPort.list();
                const selected_serialport = serialport_list.find((serialport) => serialport.path === select_serialport_path);
                if (!selected_serialport) {
                    throw new Error(`Serial Port ${select_serialport_path} Not Found`);
                }
                const serialport = new SerialPort({
                    path: selected_serialport.path,
                    baudRate: 9600
                });
                this.serialport_map.set(select_serialport_path, serialport);
            } catch (error) {
                console.log(error);
                return socket.disconnect();
            }
        });
    }

    on(event: string, listener: (...args: any[]) => void): void {
        this.io.on(event, listener);
    }

    of(namespace: RegExp | string) {
        return this.io.of(namespace);
    }
}
