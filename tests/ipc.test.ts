/* eslint-disable no-undef */
/**
 * End-to-end over the in-process Node IPC transport: a real RemoteSerialportServer (with
 * SerialPortMock injected) talking to the real RemoteSerialportClient through a
 * `worker_threads.MessageChannel` pair. Exercises mux mode (the IPC transport is single-endpoint;
 * many remote ports per IPC pair via mux).
 *
 * Requires the client to be built first.
 */
import path from "path";
import { MessageChannel } from "worker_threads";
import { SerialPortMock } from "serialport";
import { MockBinding } from "@serialport/binding-mock";
import { RemoteSerialportServer, NodeIpcServer } from "../src/index";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { RemoteSerialportClient, NodeIpcClient } = require(path.join(__dirname, "..", "..", "remote-serialport-client", "dist", "index.js"));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms: number, what: string): Promise<void> {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        try { if (pred() === true) { return; } } catch { /* */ }
        await sleep(20);
    }
    throw new Error(`timeout waiting for: ${what}`);
}

describe("remote-serialport over Node IPC (mux mode)", () => {
    const createdMocks = new Map<string, SerialPortMock>();

    function setup(): { server: RemoteSerialportServer; rsc: any; close: () => Promise<void> } {
        const channel = new MessageChannel();
        const server: RemoteSerialportServer = new RemoteSerialportServer(undefined, 0, {
            transport_server: new NodeIpcServer(channel.port1, "/"),
            serialport_factory: (opts: any): any => {
                const m = new SerialPortMock(opts);
                createdMocks.set(opts.path, m);
                return m;
            }
        });
        server.listen(); // no-op for IPC
        server.mux().on("connection", (socket): void => { socket.pipe(); });

        const rsc = new RemoteSerialportClient("", {
            transport_client: new NodeIpcClient(channel.port2, "/")
        });

        return {
            server: server,
            rsc: rsc,
            close: async (): Promise<void> => {
                try { rsc.disconnect(); } catch { /* */ }
                try { server.close(); } catch { /* */ }
                await sleep(50);
            }
        };
    }

    afterEach(() => {
        createdMocks.clear();
    });

    test("open -> device->client -> client->device", async () => {
        MockBinding.createPort("/dev/ttyACM5", { echo: false, record: true });
        const { rsc, close } = setup();
        try {
            const mux = rsc.mux();
            mux.open("/dev/ttyACM5", { path: "/dev/ttyACM5", baudRate: 115200 });
            const received: string[] = [];
            const stream = mux.create_port("/dev/ttyACM5", "/dev/ttyIPC").get_port({ baudRate: 115200, autoOpen: true });
            stream.on("data", (d: Buffer): number => received.push(Buffer.from(d).toString("utf8")));

            await waitFor((): boolean => mux.get_state("/dev/ttyACM5") === "open", 5000, "IPC mux port OPEN");

            createdMocks.get("/dev/ttyACM5")!.port!.emitData(Buffer.from("IPC-HELLO"));
            await waitFor((): boolean => received.includes("IPC-HELLO"), 2000, "IPC bytes received");
            expect(received).toContain("IPC-HELLO");

            stream.write(Buffer.from("APP-WROTE"));
            await waitFor((): boolean => createdMocks.get("/dev/ttyACM5")!.port!.lastWrite !== null, 2000, "device write");
            expect(Buffer.from(createdMocks.get("/dev/ttyACM5")!.port!.lastWrite as Buffer).toString("utf8")).toBe("APP-WROTE");
        } finally {
            await close();
        }
    }, 15000);

    test("RPC: get_remote_status works over IPC ack envelope", async () => {
        MockBinding.createPort("/dev/ttyACM6", { echo: false, record: true });
        const { rsc, close } = setup();
        try {
            const mux = rsc.mux();
            mux.open("/dev/ttyACM6", { path: "/dev/ttyACM6", baudRate: 115200 });
            await waitFor((): boolean => mux.get_state("/dev/ttyACM6") === "open", 5000, "open");

            const status = await mux.get_remote_status("/dev/ttyACM6");
            expect(status).toHaveProperty("cts");
            expect(status).toHaveProperty("dsr");
            expect(status).toHaveProperty("dcd");
        } finally {
            await close();
        }
    }, 15000);

    test("Txn over IPC: multi-chunk write delivered atomically", async () => {
        MockBinding.createPort("/dev/ttyACM7", { echo: false, record: true });
        const { rsc, close } = setup();
        try {
            const mux = rsc.mux();
            mux.open("/dev/ttyACM7", { path: "/dev/ttyACM7", baudRate: 115200 });
            await waitFor((): boolean => mux.get_state("/dev/ttyACM7") === "open", 5000, "open");

            const inst = mux.create_port("/dev/ttyACM7", "/dev/ttyIPCtxn");
            inst.get_port({ baudRate: 115200, autoOpen: true });

            const tx = inst.txn();
            tx.write(Buffer.from("HEAD_"));
            tx.write(Buffer.from("MID_"));
            tx.write(Buffer.from("TAIL"));
            await tx.end();
            const lw = createdMocks.get("/dev/ttyACM7")!.port!.lastWrite;
            expect(lw && Buffer.from(lw).toString("utf8")).toBe("HEAD_MID_TAIL");
        } finally {
            await close();
        }
    }, 15000);

    test("disconnect: client.close() tears down both sides", async () => {
        MockBinding.createPort("/dev/ttyACM8", { echo: false, record: true });
        const { server, rsc, close } = setup();
        try {
            const mux = rsc.mux();
            mux.open("/dev/ttyACM8", { path: "/dev/ttyACM8", baudRate: 115200 });
            await waitFor((): boolean => mux.get_state("/dev/ttyACM8") === "open", 5000, "open");

            rsc.disconnect();
            await sleep(150);
            // server-side mux_socket_map should be empty after disconnect
            const mux_map: Map<string, unknown> = (server as any).mux_socket_map;
            expect(mux_map.size).toBe(0);
        } finally {
            await close();
        }
    }, 15000);
});
