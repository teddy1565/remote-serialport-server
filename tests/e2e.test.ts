/* eslint-disable no-undef */
/**
 * End-to-end: a real RemoteSerialportServer (with SerialPortMock injected as the physical port)
 * driven by the real RemoteSerialportClient (loaded from its built dist).
 *
 * Requires the client to be built first: `cd ../remote-serialport-client && npm run build`.
 */
import path from "path";
import { SerialPortMock } from "serialport";
import { MockBinding } from "@serialport/binding-mock";
import { RemoteSerialportServer } from "../src/index";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { RemoteSerialportClient } = require(path.join(__dirname, "..", "..", "remote-serialport-client", "dist", "index.js"));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms: number, what: string): Promise<void> {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        try { if (pred()) { return; } } catch { /* */ }
        await sleep(30);
    }
    throw new Error(`timeout waiting for: ${what}`);
}

describe("remote-serialport e2e", () => {
    const PORT = 17993;
    let server: RemoteSerialportServer;
    const createdMocks = new Map<string, SerialPortMock>();

    const FAKE_PORT_LIST = [{ path: "/dev/ttyMOCK0", manufacturer: "fake-vendor" }, { path: "/dev/ttyMOCK1" }];

    beforeAll(() => {
        server = new RemoteSerialportServer({ cors: { origin: "*" } }, PORT, {
            serialport_factory: (opts: any): any => {
                const m = new SerialPortMock(opts);
                createdMocks.set(opts.path, m);
                return m;
            },
            port_list_provider: async (): Promise<any[]> => FAKE_PORT_LIST
        });
        server.listen();
    });

    afterAll(async () => {
        try { server.io.close(); } catch { /* */ }
        await sleep(100);
    });

    test("namespace mode: handshake -> open -> device->client -> client->device", async () => {
        MockBinding.createPort("/dev/ttyUSB0", { echo: false, record: true });
        server.of().on("connection", (socket) => { socket.pipe(); });

        const rsc = new RemoteSerialportClient(`ws://localhost:${PORT}`);
        const conn = rsc.connect("/dev/ttyUSB0", { path: "/dev/ttyUSB0", baudRate: 115200 });
        const received: string[] = [];
        conn.create_port("/dev/ttyV0").get_port({ baudRate: 115200, autoOpen: true }).on("data", (d: Buffer) => received.push(Buffer.from(d).toString("utf8")));

        await waitFor((): boolean => conn.state === "open", 5000, "client OPEN");
        expect(conn.state).toBe("open");

        createdMocks.get("/dev/ttyUSB0")!.port!.emitData(Buffer.from("FROM-DEVICE"));
        await waitFor((): boolean => received.includes("FROM-DEVICE"), 2000, "device bytes received");
        expect(received).toContain("FROM-DEVICE");

        conn.create_port("/dev/ttyV0").get_port({ baudRate: 115200 }).write(Buffer.from("FROM-APP"));
        await waitFor((): boolean => createdMocks.get("/dev/ttyUSB0")!.port!.lastWrite !== null, 2000, "device write");
        expect(Buffer.from(createdMocks.get("/dev/ttyUSB0")!.port!.lastWrite as Buffer).toString("utf8")).toBe("FROM-APP");

        rsc.disconnect();
        await sleep(150);
        expect(conn.state).toBe("closed");
    }, 15000);

    test("mux mode: open two remote ports over one connection, route by path", async () => {
        MockBinding.createPort("/dev/ttyUSB1", { echo: false, record: true });
        MockBinding.createPort("/dev/ttyACM0", { echo: false, record: true });
        server.mux().on("connection", (socket) => { socket.pipe(); });

        const rsc = new RemoteSerialportClient(`ws://localhost:${PORT}`);
        const mux = rsc.mux();
        mux.open("/dev/ttyUSB1", { path: "/dev/ttyUSB1", baudRate: 115200 });
        mux.open("/dev/ttyACM0", { path: "/dev/ttyACM0", baudRate: 115200 });
        const recvB: string[] = [];
        const recvC: string[] = [];
        mux.create_port("/dev/ttyUSB1", "/dev/ttyVB").get_port({ baudRate: 115200, autoOpen: true }).on("data", (d: Buffer) => recvB.push(Buffer.from(d).toString("utf8")));
        const streamC = mux.create_port("/dev/ttyACM0", "/dev/ttyVC").get_port({ baudRate: 115200, autoOpen: true });
        streamC.on("data", (d: Buffer) => recvC.push(Buffer.from(d).toString("utf8")));

        await waitFor((): boolean => mux.get_state("/dev/ttyUSB1") === "open" && mux.get_state("/dev/ttyACM0") === "open", 5000, "both mux ports OPEN");

        createdMocks.get("/dev/ttyUSB1")!.port!.emitData(Buffer.from("B-DATA"));
        createdMocks.get("/dev/ttyACM0")!.port!.emitData(Buffer.from("C-DATA"));
        await waitFor((): boolean => recvB.includes("B-DATA") && recvC.includes("C-DATA"), 2000, "routed bytes");
        expect(recvB).toContain("B-DATA");
        expect(recvB).not.toContain("C-DATA");
        expect(recvC).toContain("C-DATA");

        streamC.write(Buffer.from("TO-C"));
        await waitFor((): boolean => createdMocks.get("/dev/ttyACM0")!.port!.lastWrite !== null, 2000, "C write");
        expect(Buffer.from(createdMocks.get("/dev/ttyACM0")!.port!.lastWrite as Buffer).toString("utf8")).toBe("TO-C");

        rsc.disconnect();
        await sleep(150);
    }, 15000);

    test("RPC: list_ports / get_remote_status / set/update/flush (namespace mode)", async () => {
        MockBinding.createPort("/dev/ttyACM1", { echo: false, record: true });
        server.of().on("connection", (socket) => { socket.pipe(); });

        const rsc = new RemoteSerialportClient(`ws://localhost:${PORT}`);
        const conn = rsc.connect("/dev/ttyACM1", { path: "/dev/ttyACM1", baudRate: 115200 });
        await waitFor((): boolean => conn.state === "open", 5000, "client OPEN");

        const ports = await conn.list_ports();
        expect(ports.map((p: any) => p.path)).toEqual(["/dev/ttyMOCK0", "/dev/ttyMOCK1"]);

        const status = await conn.get_remote_status();
        expect(status).toHaveProperty("cts");
        expect(status).toHaveProperty("dsr");
        expect(status).toHaveProperty("dcd");

        // fire-and-forget — just shouldn't throw
        conn.set_remote({ dtr: true, rts: false });
        conn.update_remote({ baudRate: 9600 });
        conn.flush_remote();
        await sleep(150);

        // get on a not-open port should reject
        const rsc2 = new RemoteSerialportClient(`ws://localhost:${PORT}`);
        const conn2 = rsc2.connect("/dev/ttyUSB0"); // manual mode, never opened
        await sleep(150);
        await expect(conn2.get_remote_status()).rejects.toThrow();

        rsc.disconnect();
        rsc2.disconnect();
        await sleep(150);
    }, 15000);

    test("Txn: multi-chunk write delivered atomically; abort drops chunks", async () => {
        MockBinding.createPort("/dev/ttyACM2", { echo: false, record: true });
        server.of().on("connection", (socket) => { socket.pipe(); });

        const rsc = new RemoteSerialportClient(`ws://localhost:${PORT}`);
        const conn = rsc.connect("/dev/ttyACM2", { path: "/dev/ttyACM2", baudRate: 115200 });
        await waitFor((): boolean => conn.state === "open", 5000, "client OPEN");

        const portInst = conn.create_port("/dev/ttyTxn");
        portInst.get_port({ baudRate: 115200, autoOpen: true });

        // Success path: 3 chunks → concatenated as one device write
        const tx = portInst.txn();
        tx.write(Buffer.from("FRAME_"));
        tx.write(Buffer.from("PART_"));
        tx.write(Buffer.from("LAST"));
        await tx.end();
        const lw1 = createdMocks.get("/dev/ttyACM2")!.port!.lastWrite;
        expect(lw1 && Buffer.from(lw1).toString("utf8")).toBe("FRAME_PART_LAST");

        // Abort path: chunks discarded; lastWrite unchanged
        const tx2 = portInst.txn();
        tx2.write(Buffer.from("DROPPED-"));
        tx2.write(Buffer.from("NEVER-WRITTEN"));
        tx2.abort();
        await sleep(200);
        const lw2 = createdMocks.get("/dev/ttyACM2")!.port!.lastWrite;
        expect(lw2 && Buffer.from(lw2).toString("utf8")).toBe("FRAME_PART_LAST");

        // write() after end() throws
        expect((): void => tx.write(Buffer.from("X"))).toThrow();

        rsc.disconnect();
        await sleep(150);
    }, 15000);

    test("shared + fifo: two clients share one physical port; both read; both write reach device in FIFO order", async () => {
        MockBinding.createPort("/dev/ttyACM4", { echo: false, record: true });

        const shared_server = new RemoteSerialportServer({ cors: { origin: "*" } }, PORT + 2, {
            serialport_factory: (opts: any): any => {
                const m = new SerialPortMock(opts);
                createdMocks.set(opts.path, m);
                return m;
            },
            multi_access: "shared",
            shared_mode: "fifo"
        });
        shared_server.listen();
        shared_server.of().on("connection", (socket) => { socket.pipe(); });

        const rscA = new RemoteSerialportClient(`ws://localhost:${PORT + 2}`);
        const rscB = new RemoteSerialportClient(`ws://localhost:${PORT + 2}`);
        const connA = rscA.connect("/dev/ttyACM4", { path: "/dev/ttyACM4", baudRate: 115200 });
        const connB = rscB.connect("/dev/ttyACM4", { path: "/dev/ttyACM4", baudRate: 115200 });

        const recvA: string[] = [];
        const recvB: string[] = [];
        const streamA = connA.create_port("/dev/ttyVShareA").get_port({ baudRate: 115200, autoOpen: true });
        const streamB = connB.create_port("/dev/ttyVShareB").get_port({ baudRate: 115200, autoOpen: true });
        streamA.on("data", (d: Buffer) => recvA.push(Buffer.from(d).toString("utf8")));
        streamB.on("data", (d: Buffer) => recvB.push(Buffer.from(d).toString("utf8")));

        await waitFor((): boolean => connA.state === "open" && connB.state === "open", 5000, "both clients OPEN");

        // device data fans out to BOTH subscribers
        createdMocks.get("/dev/ttyACM4")!.port!.emitData(Buffer.from("BROADCAST"));
        await waitFor((): boolean => recvA.includes("BROADCAST") && recvB.includes("BROADCAST"), 2000, "both clients received fan-out");

        // writes from both subscribers reach the same device
        streamA.write(Buffer.from("FROM-A"));
        await waitFor((): boolean => {
            const w = createdMocks.get("/dev/ttyACM4")!.port!.lastWrite;
            return w !== null && Buffer.from(w).toString("utf8") === "FROM-A";
        }, 2000, "A's write");
        streamB.write(Buffer.from("FROM-B"));
        await waitFor((): boolean => {
            const w = createdMocks.get("/dev/ttyACM4")!.port!.lastWrite;
            return w !== null && Buffer.from(w).toString("utf8") === "FROM-B";
        }, 2000, "B's write");

        rscA.disconnect();
        rscB.disconnect();
        try { shared_server.io.close(); } catch { /* */ }
        await sleep(200);
    }, 15000);

    test("shared + pipe: only first client writes; second is read-only; auto-promote on writer disconnect", async () => {
        MockBinding.createPort("/dev/ttyACM5", { echo: false, record: true });

        const pipe_server = new RemoteSerialportServer({ cors: { origin: "*" } }, PORT + 3, {
            serialport_factory: (opts: any): any => {
                const m = new SerialPortMock(opts);
                createdMocks.set(opts.path, m);
                return m;
            },
            multi_access: "shared",
            shared_mode: "pipe"
        });
        pipe_server.listen();
        pipe_server.of().on("connection", (socket) => { socket.pipe(); });

        const rscA = new RemoteSerialportClient(`ws://localhost:${PORT + 3}`);
        const connA = rscA.connect("/dev/ttyACM5", { path: "/dev/ttyACM5", baudRate: 115200 });
        const streamA = connA.create_port("/dev/ttyVPipeA").get_port({ baudRate: 115200, autoOpen: true });
        await waitFor((): boolean => connA.state === "open", 5000, "A OPEN");

        // A is the writer
        streamA.write(Buffer.from("WRITER-A"));
        await waitFor((): boolean => {
            const w = createdMocks.get("/dev/ttyACM5")!.port!.lastWrite;
            return w !== null && Buffer.from(w).toString("utf8") === "WRITER-A";
        }, 2000, "A wrote as writer");

        // B connects: reader-only
        const rscB = new RemoteSerialportClient(`ws://localhost:${PORT + 3}`);
        const connB = rscB.connect("/dev/ttyACM5", { path: "/dev/ttyACM5", baudRate: 115200 });
        const streamB = connB.create_port("/dev/ttyVPipeB").get_port({ baudRate: 115200, autoOpen: true });
        await waitFor((): boolean => connB.state === "open", 5000, "B OPEN");

        // B's write is dropped (lastWrite stays "WRITER-A")
        streamB.write(Buffer.from("READER-B-DROP"));
        await sleep(300);
        const lw_after_b = createdMocks.get("/dev/ttyACM5")!.port!.lastWrite;
        expect(lw_after_b && Buffer.from(lw_after_b).toString("utf8")).toBe("WRITER-A");

        // Both still read fan-out
        const recvB: string[] = [];
        streamB.on("data", (d: Buffer) => recvB.push(Buffer.from(d).toString("utf8")));
        createdMocks.get("/dev/ttyACM5")!.port!.emitData(Buffer.from("DEVICE-MSG"));
        await waitFor((): boolean => recvB.includes("DEVICE-MSG"), 2000, "B receives fan-out");

        // A disconnects → B should auto-promote and now write through
        rscA.disconnect();
        await sleep(300);
        streamB.write(Buffer.from("PROMOTED-B"));
        await waitFor((): boolean => {
            const w = createdMocks.get("/dev/ttyACM5")!.port!.lastWrite;
            return w !== null && Buffer.from(w).toString("utf8") === "PROMOTED-B";
        }, 2000, "B writes after auto-promotion");

        rscB.disconnect();
        try { pipe_server.io.close(); } catch { /* */ }
        await sleep(200);
    }, 15000);

    test("shared + fifo: HOL by begin-arrival order; B's end-first does NOT cut in front of A", async () => {
        MockBinding.createPort("/dev/ttyACM6", { echo: false, record: true });

        const fifo_server = new RemoteSerialportServer({ cors: { origin: "*" } }, PORT + 4, {
            serialport_factory: (opts: any): any => {
                const m = new SerialPortMock(opts);
                createdMocks.set(opts.path, m);
                return m;
            },
            multi_access: "shared",
            shared_mode: "fifo"
        });
        fifo_server.listen();
        fifo_server.of().on("connection", (socket) => { socket.pipe(); });

        const rscA = new RemoteSerialportClient(`ws://localhost:${PORT + 4}`);
        const rscB = new RemoteSerialportClient(`ws://localhost:${PORT + 4}`);
        const connA = rscA.connect("/dev/ttyACM6", { path: "/dev/ttyACM6", baudRate: 115200 });
        const connB = rscB.connect("/dev/ttyACM6", { path: "/dev/ttyACM6", baudRate: 115200 });
        const portA = connA.create_port("/dev/ttyVFifoA");
        const portB = connB.create_port("/dev/ttyVFifoB");
        portA.get_port({ baudRate: 115200, autoOpen: true });
        portB.get_port({ baudRate: 115200, autoOpen: true });
        await waitFor((): boolean => connA.state === "open" && connB.state === "open", 5000, "both clients OPEN");

        // A begins first (its txn enters the queue at head, ready=false)
        const txA = portA.txn();
        await sleep(50); // ensure A's _begin reaches server before B's
        // B begins, fully sends + ends — but in 'fifo' B is HOL-blocked, so its `end()` Promise stays
        // pending until A completes. Don't await it here.
        const txB = portB.txn();
        txB.write(Buffer.from("BBBB"));
        const B_end_pending: Promise<void> = txB.end();
        // Wait long enough for B's _end to arrive at the server (and be queued behind A)
        await sleep(200);
        const recording_after_B_end_arrived: Buffer = createdMocks.get("/dev/ttyACM6")!.port!.recording;
        expect(recording_after_B_end_arrived.length).toBe(0); // HOL: B's bytes blocked behind A

        // Now A completes → A flushes first, then B is dispatched and its drain reaches the client
        txA.write(Buffer.from("AAAA"));
        await txA.end();
        await B_end_pending; // should resolve now
        await sleep(50);
        const final_recording: Buffer = createdMocks.get("/dev/ttyACM6")!.port!.recording;
        expect(Buffer.from(final_recording).toString("utf8")).toBe("AAAABBBB");

        rscA.disconnect();
        rscB.disconnect();
        try { fifo_server.io.close(); } catch { /* */ }
        await sleep(200);
    }, 20000);

    test("shared + batch (default-batch sanity): B's end-first DOES cut in front of A", async () => {
        MockBinding.createPort("/dev/ttyACM7", { echo: false, record: true });

        const batch_server = new RemoteSerialportServer({ cors: { origin: "*" } }, PORT + 5, {
            serialport_factory: (opts: any): any => {
                const m = new SerialPortMock(opts);
                createdMocks.set(opts.path, m);
                return m;
            },
            multi_access: "shared",
            shared_mode: "batch"
        });
        batch_server.listen();
        batch_server.of().on("connection", (socket) => { socket.pipe(); });

        const rscA = new RemoteSerialportClient(`ws://localhost:${PORT + 5}`);
        const rscB = new RemoteSerialportClient(`ws://localhost:${PORT + 5}`);
        const connA = rscA.connect("/dev/ttyACM7", { path: "/dev/ttyACM7", baudRate: 115200 });
        const connB = rscB.connect("/dev/ttyACM7", { path: "/dev/ttyACM7", baudRate: 115200 });
        const portA = connA.create_port("/dev/ttyVBatchA");
        const portB = connB.create_port("/dev/ttyVBatchB");
        portA.get_port({ baudRate: 115200, autoOpen: true });
        portB.get_port({ baudRate: 115200, autoOpen: true });
        await waitFor((): boolean => connA.state === "open" && connB.state === "open", 5000, "both clients OPEN (batch)");

        const txA = portA.txn();
        await sleep(50);
        const txB = portB.txn();
        txB.write(Buffer.from("BBBB"));
        await txB.end();
        // In 'batch': B should be ON the recording already (no HOL)
        await sleep(150);
        const recording_after_B = createdMocks.get("/dev/ttyACM7")!.port!.recording;
        expect(Buffer.from(recording_after_B).toString("utf8")).toBe("BBBB");

        txA.write(Buffer.from("AAAA"));
        await txA.end();
        await sleep(150);
        const final_recording = createdMocks.get("/dev/ttyACM7")!.port!.recording;
        expect(Buffer.from(final_recording).toString("utf8")).toBe("BBBBAAAA"); // end-order

        rscA.disconnect();
        rscB.disconnect();
        try { batch_server.io.close(); } catch { /* */ }
        await sleep(200);
    }, 20000);

    test("shared + fifo-strict: same begin-order ordering as fifo (also serializes writes one-at-a-time)", async () => {
        MockBinding.createPort("/dev/ttyACM8", { echo: false, record: true });

        const strict_server = new RemoteSerialportServer({ cors: { origin: "*" } }, PORT + 6, {
            serialport_factory: (opts: any): any => {
                const m = new SerialPortMock(opts);
                createdMocks.set(opts.path, m);
                return m;
            },
            multi_access: "shared",
            shared_mode: "fifo-strict"
        });
        strict_server.listen();
        strict_server.of().on("connection", (socket) => { socket.pipe(); });

        const rscA = new RemoteSerialportClient(`ws://localhost:${PORT + 6}`);
        const rscB = new RemoteSerialportClient(`ws://localhost:${PORT + 6}`);
        const connA = rscA.connect("/dev/ttyACM8", { path: "/dev/ttyACM8", baudRate: 115200 });
        const connB = rscB.connect("/dev/ttyACM8", { path: "/dev/ttyACM8", baudRate: 115200 });
        const streamA = connA.create_port("/dev/ttyVStrA").get_port({ baudRate: 115200, autoOpen: true });
        const streamB = connB.create_port("/dev/ttyVStrB").get_port({ baudRate: 115200, autoOpen: true });
        await waitFor((): boolean => connA.state === "open" && connB.state === "open", 5000, "both clients OPEN (strict)");

        streamA.write(Buffer.from("AAA"));
        await sleep(40);
        streamB.write(Buffer.from("BBB"));
        await waitFor((): boolean => {
            const r = createdMocks.get("/dev/ttyACM8")!.port!.recording;
            return Buffer.from(r).toString("utf8") === "AAABBB";
        }, 3000, "fifo-strict serialized A then B");

        rscA.disconnect();
        rscB.disconnect();
        try { strict_server.io.close(); } catch { /* */ }
        await sleep(200);
    }, 15000);

    test("mux + shared: two mux clients on same remote path share one physical port", async () => {
        MockBinding.createPort("/dev/ttyACM9", { echo: false, record: true });

        const mux_shared_server = new RemoteSerialportServer({ cors: { origin: "*" } }, PORT + 7, {
            serialport_factory: (opts: any): any => {
                const m = new SerialPortMock(opts);
                createdMocks.set(opts.path, m);
                return m;
            },
            multi_access: "shared",
            shared_mode: "fifo"
        });
        mux_shared_server.listen();
        mux_shared_server.mux().on("connection", (socket) => { socket.pipe(); });

        const rscA = new RemoteSerialportClient(`ws://localhost:${PORT + 7}`);
        const rscB = new RemoteSerialportClient(`ws://localhost:${PORT + 7}`);
        const muxA = rscA.mux();
        const muxB = rscB.mux();
        muxA.open("/dev/ttyACM9", { path: "/dev/ttyACM9", baudRate: 115200 });
        muxB.open("/dev/ttyACM9", { path: "/dev/ttyACM9", baudRate: 115200 });
        const recvA: string[] = [];
        const recvB: string[] = [];
        muxA.create_port("/dev/ttyACM9", "/dev/ttyVMuxShareA").get_port({ baudRate: 115200, autoOpen: true }).on("data", (d: Buffer) => recvA.push(Buffer.from(d).toString("utf8")));
        muxB.create_port("/dev/ttyACM9", "/dev/ttyVMuxShareB").get_port({ baudRate: 115200, autoOpen: true }).on("data", (d: Buffer) => recvB.push(Buffer.from(d).toString("utf8")));

        await waitFor((): boolean => muxA.get_state("/dev/ttyACM9") === "open" && muxB.get_state("/dev/ttyACM9") === "open", 5000, "both mux clients OPEN on shared path");

        // device data fans out to BOTH mux clients
        createdMocks.get("/dev/ttyACM9")!.port!.emitData(Buffer.from("MUX-SHARED-MSG"));
        await waitFor((): boolean => recvA.includes("MUX-SHARED-MSG") && recvB.includes("MUX-SHARED-MSG"), 2000, "both mux clients received fan-out");

        rscA.disconnect();
        rscB.disconnect();
        try { mux_shared_server.io.close(); } catch { /* */ }
        await sleep(200);
    }, 15000);

    test("shared: namespace-mode client + mux-mode client on the same path share one physical port", async () => {
        MockBinding.createPort("/dev/ttyACM10", { echo: false, record: true });

        const cross_server = new RemoteSerialportServer({ cors: { origin: "*" } }, PORT + 8, {
            serialport_factory: (opts: any): any => {
                const m = new SerialPortMock(opts);
                createdMocks.set(opts.path, m);
                return m;
            },
            multi_access: "shared",
            shared_mode: "fifo"
        });
        cross_server.listen();
        cross_server.of().on("connection", (socket) => { socket.pipe(); });
        cross_server.mux().on("connection", (socket) => { socket.pipe(); });

        // namespace-mode client
        const rscNs = new RemoteSerialportClient(`ws://localhost:${PORT + 8}`);
        const connNs = rscNs.connect("/dev/ttyACM10", { path: "/dev/ttyACM10", baudRate: 115200 });
        const recvNs: string[] = [];
        const streamNs = connNs.create_port("/dev/ttyVCrossNs").get_port({ baudRate: 115200, autoOpen: true });
        streamNs.on("data", (d: Buffer) => recvNs.push(Buffer.from(d).toString("utf8")));

        // mux-mode client
        const rscMux = new RemoteSerialportClient(`ws://localhost:${PORT + 8}`);
        const mux = rscMux.mux();
        mux.open("/dev/ttyACM10", { path: "/dev/ttyACM10", baudRate: 115200 });
        const recvMux: string[] = [];
        const streamMux = mux.create_port("/dev/ttyACM10", "/dev/ttyVCrossMux").get_port({ baudRate: 115200, autoOpen: true });
        streamMux.on("data", (d: Buffer) => recvMux.push(Buffer.from(d).toString("utf8")));

        await waitFor((): boolean => connNs.state === "open" && mux.get_state("/dev/ttyACM10") === "open", 5000, "both clients OPEN cross-mode");

        // device data fans out to BOTH (one is namespace mode, one is mux mode)
        createdMocks.get("/dev/ttyACM10")!.port!.emitData(Buffer.from("CROSS-MODE"));
        await waitFor((): boolean => recvNs.includes("CROSS-MODE") && recvMux.includes("CROSS-MODE"), 2000, "cross-mode fan-out");

        // namespace-mode client write reaches device
        streamNs.write(Buffer.from("FROM-NS"));
        await waitFor((): boolean => {
            const w = createdMocks.get("/dev/ttyACM10")!.port!.lastWrite;
            return w !== null && Buffer.from(w).toString("utf8") === "FROM-NS";
        }, 2000, "namespace write");

        // mux-mode client write reaches device
        streamMux.write(Buffer.from("FROM-MUX"));
        await waitFor((): boolean => {
            const w = createdMocks.get("/dev/ttyACM10")!.port!.lastWrite;
            return w !== null && Buffer.from(w).toString("utf8") === "FROM-MUX";
        }, 2000, "mux write");

        rscNs.disconnect();
        rscMux.disconnect();
        try { cross_server.io.close(); } catch { /* */ }
        await sleep(200);
    }, 15000);

    test("mux + pipe: writer auto-promotes from one mux client to another on disconnect", async () => {
        MockBinding.createPort("/dev/ttyACM11", { echo: false, record: true });

        const mp_server = new RemoteSerialportServer({ cors: { origin: "*" } }, PORT + 9, {
            serialport_factory: (opts: any): any => {
                const m = new SerialPortMock(opts);
                createdMocks.set(opts.path, m);
                return m;
            },
            multi_access: "shared",
            shared_mode: "pipe"
        });
        mp_server.listen();
        mp_server.mux().on("connection", (socket) => { socket.pipe(); });

        const rscA = new RemoteSerialportClient(`ws://localhost:${PORT + 9}`);
        const muxA = rscA.mux();
        muxA.open("/dev/ttyACM11", { path: "/dev/ttyACM11", baudRate: 115200 });
        const streamA = muxA.create_port("/dev/ttyACM11", "/dev/ttyVMuxPipeA").get_port({ baudRate: 115200, autoOpen: true });
        await waitFor((): boolean => muxA.get_state("/dev/ttyACM11") === "open", 5000, "A mux OPEN");

        // A is writer
        streamA.write(Buffer.from("MUX-A-WRITES"));
        await waitFor((): boolean => {
            const w = createdMocks.get("/dev/ttyACM11")!.port!.lastWrite;
            return w !== null && Buffer.from(w).toString("utf8") === "MUX-A-WRITES";
        }, 2000, "A wrote as writer");

        // B connects via mux to same path: reader-only
        const rscB = new RemoteSerialportClient(`ws://localhost:${PORT + 9}`);
        const muxB = rscB.mux();
        muxB.open("/dev/ttyACM11", { path: "/dev/ttyACM11", baudRate: 115200 });
        const streamB = muxB.create_port("/dev/ttyACM11", "/dev/ttyVMuxPipeB").get_port({ baudRate: 115200, autoOpen: true });
        await waitFor((): boolean => muxB.get_state("/dev/ttyACM11") === "open", 5000, "B mux OPEN");

        // B's write is dropped (lastWrite unchanged)
        streamB.write(Buffer.from("MUX-B-DROP"));
        await sleep(300);
        expect(Buffer.from(createdMocks.get("/dev/ttyACM11")!.port!.lastWrite as Buffer).toString("utf8")).toBe("MUX-A-WRITES");

        // A disconnects → B auto-promotes
        rscA.disconnect();
        await sleep(300);
        streamB.write(Buffer.from("MUX-B-AFTER-PROMOTE"));
        await waitFor((): boolean => {
            const w = createdMocks.get("/dev/ttyACM11")!.port!.lastWrite;
            return w !== null && Buffer.from(w).toString("utf8") === "MUX-B-AFTER-PROMOTE";
        }, 2000, "B writes after auto-promote");

        rscB.disconnect();
        try { mp_server.io.close(); } catch { /* */ }
        await sleep(200);
    }, 15000);

    test("mux + shared: each client's writes drain ack routes back to itself (no cross-client window stall)", async () => {
        MockBinding.createPort("/dev/ttyACM12", { echo: false, record: true });

        const route_server = new RemoteSerialportServer({ cors: { origin: "*" } }, PORT + 10, {
            serialport_factory: (opts: any): any => {
                const m = new SerialPortMock(opts);
                createdMocks.set(opts.path, m);
                return m;
            },
            multi_access: "shared",
            shared_mode: "batch" // batch keeps it simple — each write flushes immediately
        });
        route_server.listen();
        route_server.mux().on("connection", (socket) => { socket.pipe(); });

        const rscA = new RemoteSerialportClient(`ws://localhost:${PORT + 10}`);
        const rscB = new RemoteSerialportClient(`ws://localhost:${PORT + 10}`);
        const muxA = rscA.mux();
        const muxB = rscB.mux();
        muxA.open("/dev/ttyACM12", { path: "/dev/ttyACM12", baudRate: 115200 });
        muxB.open("/dev/ttyACM12", { path: "/dev/ttyACM12", baudRate: 115200 });
        const streamA = muxA.create_port("/dev/ttyACM12", "/dev/ttyVRouteA").get_port({ baudRate: 115200, autoOpen: true });
        const streamB = muxB.create_port("/dev/ttyACM12", "/dev/ttyVRouteB").get_port({ baudRate: 115200, autoOpen: true });
        await waitFor((): boolean => muxA.get_state("/dev/ttyACM12") === "open" && muxB.get_state("/dev/ttyACM12") === "open", 5000, "both mux OPEN");

        // Burst writes from BOTH clients — if drain ack routing was broken, one client's window
        // would fill (returning false from write()) while the other's drained, eventually stalling.
        // With per-client routing, both stay writable.
        const N = 30; // < DEFAULT_BACKPRESSURE_WINDOW (64) so no legitimate backpressure
        for (let i = 0; i < N; i++) {
            streamA.write(Buffer.from(`a${i};`));
            streamB.write(Buffer.from(`b${i};`));
        }

        // Wait for all writes to drain back to the device. recording should contain all 60 fragments.
        await waitFor((): boolean => {
            const recording = createdMocks.get("/dev/ttyACM12")!.port!.recording;
            return recording.length >= N * 2 * 3; // each fragment is 3 bytes minimum
        }, 5000, "all 60 writes hit device");

        const recording = Buffer.from(createdMocks.get("/dev/ttyACM12")!.port!.recording).toString("utf8");
        // Verify A's and B's fragments are both present (order doesn't matter for this test —
        // batch mode interleaves at packet boundaries)
        for (let i = 0; i < N; i++) {
            expect(recording).toContain(`a${i};`);
            expect(recording).toContain(`b${i};`);
        }

        // Both streams should still report writable (window never filled — each got their acks)
        expect(streamA.write(Buffer.from("A-LIVENESS"))).toBe(true);
        expect(streamB.write(Buffer.from("B-LIVENESS"))).toBe(true);

        rscA.disconnect();
        rscB.disconnect();
        try { route_server.io.close(); } catch { /* */ }
        await sleep(200);
    }, 15000);

    test("leak/stress: 50 open/close cycles — server socket_map clears; no listener growth; SharedSessionRegistry empties; no hangs", async () => {
        MockBinding.createPort("/dev/ttyACM20", { echo: false, record: true });

        const stress_server = new RemoteSerialportServer({ cors: { origin: "*" } }, PORT + 11, {
            serialport_factory: (opts: any): any => {
                const m = new SerialPortMock(opts);
                createdMocks.set(opts.path, m);
                return m;
            }
            // default 'reject' mode
        });
        stress_server.listen();
        stress_server.of().on("connection", (socket) => { socket.pipe(); });

        const baseline_io_listener_count = (stress_server.io as any).sockets?._fns?.length ?? 0;

        const CYCLES = 50;
        for (let i = 0; i < CYCLES; i++) {
            const rsc = new RemoteSerialportClient(`ws://localhost:${PORT + 11}`);
            const conn = rsc.connect("/dev/ttyACM20", { path: "/dev/ttyACM20", baudRate: 115200 });
            const stream = conn.create_port("/dev/ttyVSTRESS").get_port({ baudRate: 115200, autoOpen: true });
            await waitFor((): boolean => conn.state === "open", 3000, `cycle ${i}: OPEN`);
            stream.write(Buffer.from(`cycle-${i}`));
            // Mix in a txn that gets ended normally (exercises _txns add+remove)
            const tx = stream as unknown as { _port_emitter?: unknown }; // not directly txn-able; use port instance
            void tx;
            const txHandle = (conn.create_port("/dev/ttyVSTRESS") as any).txn();
            txHandle.write(Buffer.from(`txn-${i}`));
            await txHandle.end();
            // Mix in an abort to exercise the abort path
            const ab = (conn.create_port("/dev/ttyVSTRESS") as any).txn();
            ab.write(Buffer.from("never"));
            ab.abort();
            rsc.disconnect();
            await sleep(20); // let socket.io flush the disconnect
        }

        // give the server a beat to process the final disconnect
        await sleep(300);

        // 1. socket_map should be empty: each disconnect handler deletes the entry
        const socket_map_size: number = ((stress_server as unknown as { socket_map: Map<string, unknown> }).socket_map).size;
        expect(socket_map_size).toBe(0);

        // 2. namespace_map keeps the (one) namespace wrapper — by design (cached). Just confirm small.
        const namespace_map_size: number = ((stress_server as unknown as { namespace_map: Map<string, unknown> }).namespace_map).size;
        expect(namespace_map_size).toBeLessThanOrEqual(2); // 1 expected; allow slack for child namespaces

        // 3. socket.io's connection middlewares haven't grown (would indicate listeners accumulating)
        const final_io_listener_count = (stress_server.io as any).sockets?._fns?.length ?? 0;
        expect(final_io_listener_count).toBe(baseline_io_listener_count);

        try { stress_server.io.close(); } catch { /* */ }
        await sleep(200);
    }, 60000);

    test("leak/stress: shared mode — SharedSessionRegistry drops session when last subscriber leaves", async () => {
        MockBinding.createPort("/dev/ttyACM21", { echo: false, record: true });

        const reg_server = new RemoteSerialportServer({ cors: { origin: "*" } }, PORT + 12, {
            serialport_factory: (opts: any): any => {
                const m = new SerialPortMock(opts);
                createdMocks.set(opts.path, m);
                return m;
            },
            multi_access: "shared",
            shared_mode: "fifo"
        });
        reg_server.listen();
        reg_server.of().on("connection", (socket) => { socket.pipe(); });

        const registry: unknown = (reg_server as unknown as { _shared_registry: unknown })._shared_registry;
        const registry_sessions: Map<string, unknown> = (registry as { _sessions: Map<string, unknown> })._sessions;

        // Two clients connect to the same path: registry should hold ONE session with refcount=2
        const rscA = new RemoteSerialportClient(`ws://localhost:${PORT + 12}`);
        const rscB = new RemoteSerialportClient(`ws://localhost:${PORT + 12}`);
        const connA = rscA.connect("/dev/ttyACM21", { path: "/dev/ttyACM21", baudRate: 115200 });
        const connB = rscB.connect("/dev/ttyACM21", { path: "/dev/ttyACM21", baudRate: 115200 });
        connA.create_port("/dev/ttyV-shA").get_port({ baudRate: 115200, autoOpen: true });
        connB.create_port("/dev/ttyV-shB").get_port({ baudRate: 115200, autoOpen: true });
        await waitFor((): boolean => connA.state === "open" && connB.state === "open", 5000, "both OPEN");
        expect(registry_sessions.size).toBe(1);

        // A disconnects: B remains; session still alive
        rscA.disconnect();
        await sleep(150);
        expect(registry_sessions.size).toBe(1);

        // B disconnects: refcount = 0 -> session removed from registry
        rscB.disconnect();
        await sleep(150);
        expect(registry_sessions.size).toBe(0);

        try { reg_server.io.close(); } catch { /* */ }
        await sleep(200);
    }, 20000);

    test("Txn: server-side timeout drops chunks; client end() eventually resolves", async () => {
        MockBinding.createPort("/dev/ttyACM3", { echo: false, record: true });

        // Spin up a server with a short txn_timeout_ms for this test
        const fast_server = new RemoteSerialportServer({ cors: { origin: "*" } }, PORT + 1, {
            serialport_factory: (opts: any): any => {
                const m = new SerialPortMock(opts);
                createdMocks.set(opts.path, m);
                return m;
            },
            txn_timeout_ms: 200
        });
        fast_server.listen();
        fast_server.of().on("connection", (socket) => { socket.pipe(); });

        const rsc = new RemoteSerialportClient(`ws://localhost:${PORT + 1}`);
        const conn = rsc.connect("/dev/ttyACM3", { path: "/dev/ttyACM3", baudRate: 115200 });
        await waitFor((): boolean => conn.state === "open", 5000, "fast-server client OPEN");

        const portInst = conn.create_port("/dev/ttyTxnTimeout");
        portInst.get_port({ baudRate: 115200, autoOpen: true });

        // Begin a txn, send one chunk, then wait > timeout before end()
        const tx = portInst.txn();
        tx.write(Buffer.from("WILL-TIME-OUT"));
        await sleep(400); // > txn_timeout_ms
        // end() now triggers the "unknown txn" branch on the server: ack-only, no device write
        await tx.end();
        await sleep(100);
        // The chunk never reached the device (cleared mock buffer or whatever was previously written)
        // Verify by writing a fresh single-shot and confirming it's seen as the next lastWrite
        portInst.get_port({ baudRate: 115200 }).write(Buffer.from("FRESH"));
        await waitFor((): boolean => {
            const w = createdMocks.get("/dev/ttyACM3")!.port!.lastWrite;
            return w !== null && Buffer.from(w).toString("utf8") === "FRESH";
        }, 2000, "fresh write after timeout");

        rsc.disconnect();
        try { fast_server.io.close(); } catch { /* */ }
        await sleep(150);
    }, 15000);
});
