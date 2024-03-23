import { Server } from "socket.io";
import { SerialPort } from "serialport";

const SOCKET_SERVER_PORT = 17991;

/**
 *  Of namespce like /dev/tty* or /dev/usb* or COM* or /dev/ttyUSB* or /dev/ttyACM*
 */
const SERIALPORT_NAMESPACE_REGEXP = /^(\/dev\/tty(USB|AMA|ACM)|COM)[0-9]+$/;

const io = new Server({
    cors: {
        allowedHeaders: ["*"],
        origin: "*",
        methods: ["GET", "POST", "PUT", "DELETE"]
    }
});

io.listen(SOCKET_SERVER_PORT);

console.log(`Socket Server Listening on Port ${SOCKET_SERVER_PORT}`);

io.on("connection", (socket) => {
    console.log(`Socket Connected to Server on Port ${SOCKET_SERVER_PORT}, of: /`);
    socket.on("disconnect", () => {
        console.log("Socket Disconnected");
    });
});

io.of(SERIALPORT_NAMESPACE_REGEXP).on("connection", async (socket) => {
    const select_serialport_path = socket.nsp.name;
    console.log(`Socket Connected to Server on Port ${SOCKET_SERVER_PORT}, of: ${socket.nsp.name}`);
    socket.on("disconnect", () => {
        console.log("Socket Disconnected");
    });

    let serialport: SerialPort | null = null;
    try {
        const serialport_list = await SerialPort.list();
        const selected_serialport = serialport_list.find((serialport) => serialport.path === select_serialport_path);
        if (!selected_serialport) {
            throw new Error(`Serial Port ${select_serialport_path} Not Found`);
        }
        serialport = new SerialPort({
            path: selected_serialport.path,
            baudRate: 9600
        });
    } catch (error) {
        console.log(error);
        return socket.disconnect();
    }

    serialport.on("open", () => {
        console.log(`Serial Port ${select_serialport_path} Opened`);
    });
    serialport.on("close", () => {
        console.log(`Serial Port ${select_serialport_path} Closed`);
    });
});
