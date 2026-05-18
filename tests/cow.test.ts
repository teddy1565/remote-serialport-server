/* eslint-disable no-undef */
/**
 * P5 COW shared modes: cow-write-isolate, cow-snapshot, cow-virtual-port.
 *
 * - write-isolate: device echo is routed back to the writer only (best-effort prefix match).
 * - snapshot: ring buffer of recent device output is replayed to new subscribers.
 * - virtual-port: per-subscriber set/update state is tracked; conflicts log a warning.
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
        try { if (pred() === true) { return; } } catch { /* */ }
        await sleep(20);
    }
    throw new Error(`timeout waiting for: ${what}`);
}

describe("P5 COW shared modes", () => {

    test("cow-write-isolate: device echo of A's write only reaches A; B's write only reaches B", async () => {
        const PORT = 17880;
        MockBinding.createPort("/dev/ttyACM30", { echo: true, record: true });
        const server: RemoteSerialportServer = new RemoteSerialportServer({ cors: { origin: "*" } }, PORT, {
            serialport_factory: (opts: any): any => new SerialPortMock(opts),
            multi_access: "shared",
            shared_mode: "cow-write-isolate"
        });
        server.listen();
        server.of().on("connection", (socket): void => socket.pipe());

        const rscA = new RemoteSerialportClient(`ws://localhost:${PORT}`);
        const rscB = new RemoteSerialportClient(`ws://localhost:${PORT}`);
        const connA = rscA.connect("/dev/ttyACM30", { path: "/dev/ttyACM30", baudRate: 115200 });
        const connB = rscB.connect("/dev/ttyACM30", { path: "/dev/ttyACM30", baudRate: 115200 });

        const receivedA: string[] = [];
        const receivedB: string[] = [];
        connA.create_port("/dev/ttyV-COW-A").get_port({ baudRate: 115200, autoOpen: true }).on("data", (d: Buffer): number => receivedA.push(Buffer.from(d).toString("utf8")));
        const streamA = connA.create_port("/dev/ttyV-COW-A").get_port({ baudRate: 115200 });
        connB.create_port("/dev/ttyV-COW-B").get_port({ baudRate: 115200, autoOpen: true }).on("data", (d: Buffer): number => receivedB.push(Buffer.from(d).toString("utf8")));
        const streamB = connB.create_port("/dev/ttyV-COW-B").get_port({ baudRate: 115200 });

        await waitFor((): boolean => connA.state === "open" && connB.state === "open", 5000, "both OPEN");

        // A writes; echo (echo:true on the mock binding) should land in A's receive list only.
        streamA.write(Buffer.from("FROM_A"));
        await sleep(150);

        expect(receivedA.join("")).toContain("FROM_A");
        expect(receivedB.join("")).not.toContain("FROM_A");

        streamB.write(Buffer.from("FROM_B"));
        await sleep(150);
        expect(receivedB.join("")).toContain("FROM_B");
        expect(receivedA.join("")).not.toContain("FROM_B");

        rscA.disconnect();
        rscB.disconnect();
        try { server.close(); } catch { /* */ }
        await sleep(120);
    }, 15000);

    test("cow-write-isolate: unsolicited device bytes (no matching pending_echo) fan out to everyone", async () => {
        const PORT = 17881;
        MockBinding.createPort("/dev/ttyACM31", { echo: false, record: true });
        const mocks = new Map<string, SerialPortMock>();
        const server: RemoteSerialportServer = new RemoteSerialportServer({ cors: { origin: "*" } }, PORT, {
            serialport_factory: (opts: any): any => {
                const m = new SerialPortMock(opts);
                mocks.set(opts.path, m);
                return m;
            },
            multi_access: "shared",
            shared_mode: "cow-write-isolate"
        });
        server.listen();
        server.of().on("connection", (socket): void => socket.pipe());

        const rscA = new RemoteSerialportClient(`ws://localhost:${PORT}`);
        const rscB = new RemoteSerialportClient(`ws://localhost:${PORT}`);
        const connA = rscA.connect("/dev/ttyACM31", { path: "/dev/ttyACM31", baudRate: 115200 });
        const connB = rscB.connect("/dev/ttyACM31", { path: "/dev/ttyACM31", baudRate: 115200 });

        const receivedA: string[] = [];
        const receivedB: string[] = [];
        connA.create_port("/dev/ttyV-COW-A2").get_port({ baudRate: 115200, autoOpen: true }).on("data", (d: Buffer): number => receivedA.push(Buffer.from(d).toString("utf8")));
        connB.create_port("/dev/ttyV-COW-B2").get_port({ baudRate: 115200, autoOpen: true }).on("data", (d: Buffer): number => receivedB.push(Buffer.from(d).toString("utf8")));

        await waitFor((): boolean => connA.state === "open" && connB.state === "open", 5000, "both OPEN");

        mocks.get("/dev/ttyACM31")!.port!.emitData(Buffer.from("UNSOLICITED"));
        await sleep(150);
        expect(receivedA.join("")).toContain("UNSOLICITED");
        expect(receivedB.join("")).toContain("UNSOLICITED");

        rscA.disconnect();
        rscB.disconnect();
        try { server.close(); } catch { /* */ }
        await sleep(120);
    }, 15000);

    test("cow-snapshot: late-joining subscriber receives a replay of recent device bytes", async () => {
        const PORT = 17882;
        MockBinding.createPort("/dev/ttyACM32", { echo: false, record: true });
        const mocks = new Map<string, SerialPortMock>();
        const server: RemoteSerialportServer = new RemoteSerialportServer({ cors: { origin: "*" } }, PORT, {
            serialport_factory: (opts: any): any => {
                const m = new SerialPortMock(opts);
                mocks.set(opts.path, m);
                return m;
            },
            multi_access: "shared",
            shared_mode: "cow-snapshot",
            cow_snapshot_buffer_bytes: 1024
        });
        server.listen();
        server.of().on("connection", (socket): void => socket.pipe());

        const rscA = new RemoteSerialportClient(`ws://localhost:${PORT}`);
        const connA = rscA.connect("/dev/ttyACM32", { path: "/dev/ttyACM32", baudRate: 115200 });
        const receivedA: string[] = [];
        connA.create_port("/dev/ttyV-SNAP-A").get_port({ baudRate: 115200, autoOpen: true }).on("data", (d: Buffer): number => receivedA.push(Buffer.from(d).toString("utf8")));
        await waitFor((): boolean => connA.state === "open", 5000, "A OPEN");

        // Emit history before B joins.
        mocks.get("/dev/ttyACM32")!.port!.emitData(Buffer.from("HISTORY_"));
        mocks.get("/dev/ttyACM32")!.port!.emitData(Buffer.from("BLOB"));
        await sleep(100);
        expect(receivedA.join("")).toContain("HISTORY_BLOB");

        // B joins; should replay HISTORY_BLOB on subscribe.
        const rscB = new RemoteSerialportClient(`ws://localhost:${PORT}`);
        const connB = rscB.connect("/dev/ttyACM32", { path: "/dev/ttyACM32", baudRate: 115200 });
        const receivedB: string[] = [];
        connB.create_port("/dev/ttyV-SNAP-B").get_port({ baudRate: 115200, autoOpen: true }).on("data", (d: Buffer): number => receivedB.push(Buffer.from(d).toString("utf8")));
        await waitFor((): boolean => connB.state === "open", 5000, "B OPEN");
        await sleep(100);

        // B should have received the replayed history.
        expect(receivedB.join("")).toContain("HISTORY_BLOB");

        // Live bytes after B joins: both A and B see them.
        mocks.get("/dev/ttyACM32")!.port!.emitData(Buffer.from("LIVE"));
        await sleep(100);
        expect(receivedA.join("")).toContain("LIVE");
        expect(receivedB.join("")).toContain("LIVE");

        rscA.disconnect();
        rscB.disconnect();
        try { server.close(); } catch { /* */ }
        await sleep(120);
    }, 15000);

    test("cow-snapshot: ring buffer trims when exceeding cow_snapshot_buffer_bytes", async () => {
        const PORT = 17883;
        MockBinding.createPort("/dev/ttyACM33", { echo: false, record: true });
        const mocks = new Map<string, SerialPortMock>();
        const server: RemoteSerialportServer = new RemoteSerialportServer({ cors: { origin: "*" } }, PORT, {
            serialport_factory: (opts: any): any => {
                const m = new SerialPortMock(opts);
                mocks.set(opts.path, m);
                return m;
            },
            multi_access: "shared",
            shared_mode: "cow-snapshot",
            cow_snapshot_buffer_bytes: 16 // tiny ring so we can verify trimming
        });
        server.listen();
        server.of().on("connection", (socket): void => socket.pipe());

        // First subscriber to keep port open + register the data flow.
        const rscA = new RemoteSerialportClient(`ws://localhost:${PORT}`);
        const connA = rscA.connect("/dev/ttyACM33", { path: "/dev/ttyACM33", baudRate: 115200 });
        connA.create_port("/dev/ttyV-SNAP-A2").get_port({ baudRate: 115200, autoOpen: true });
        await waitFor((): boolean => connA.state === "open", 5000, "A OPEN");

        // Emit 4 chunks of 8 bytes; ring buffer (16) should keep at most the last 16 bytes.
        for (const tag of ["AAAA1234", "BBBB5678", "CCCC9012", "DDDDXYZW"]) {
            mocks.get("/dev/ttyACM33")!.port!.emitData(Buffer.from(tag));
        }
        await sleep(100);

        // B joins late: should NOT see AAAA1234 or BBBB5678 (trimmed), should see CCCC9012 + DDDDXYZW.
        const rscB = new RemoteSerialportClient(`ws://localhost:${PORT}`);
        const connB = rscB.connect("/dev/ttyACM33", { path: "/dev/ttyACM33", baudRate: 115200 });
        const receivedB: string[] = [];
        connB.create_port("/dev/ttyV-SNAP-B2").get_port({ baudRate: 115200, autoOpen: true }).on("data", (d: Buffer): number => receivedB.push(Buffer.from(d).toString("utf8")));
        await waitFor((): boolean => connB.state === "open", 5000, "B OPEN");
        await sleep(100);

        const joinedB = receivedB.join("");
        expect(joinedB).not.toContain("AAAA1234");
        expect(joinedB).not.toContain("BBBB5678");
        expect(joinedB).toContain("CCCC9012");
        expect(joinedB).toContain("DDDDXYZW");

        rscA.disconnect();
        rscB.disconnect();
        try { server.close(); } catch { /* */ }
        await sleep(120);
    }, 15000);

    test("cow-virtual-port: conflicting set across subscribers logs a warning", async () => {
        const PORT = 17884;
        MockBinding.createPort("/dev/ttyACM34", { echo: false, record: true });
        const warnings: string[] = [];
        const captured_logger = {
            debug: (): void => undefined,
            info: (): void => undefined,
            warn: (msg: string): unknown => warnings.push(msg),
            error: (): void => undefined
        };
        const server: RemoteSerialportServer = new RemoteSerialportServer({ cors: { origin: "*" } }, PORT, {
            serialport_factory: (opts: any): any => new SerialPortMock(opts),
            multi_access: "shared",
            shared_mode: "cow-virtual-port",
            logger: captured_logger
        });
        server.listen();
        server.of().on("connection", (socket): void => socket.pipe());

        const rscA = new RemoteSerialportClient(`ws://localhost:${PORT}`);
        const rscB = new RemoteSerialportClient(`ws://localhost:${PORT}`);
        const connA = rscA.connect("/dev/ttyACM34", { path: "/dev/ttyACM34", baudRate: 115200 });
        const connB = rscB.connect("/dev/ttyACM34", { path: "/dev/ttyACM34", baudRate: 115200 });

        await waitFor((): boolean => connA.state === "open" && connB.state === "open", 5000, "both OPEN");

        // A sets dtr=true; B then sets dtr=false → conflict.
        connA.set_remote({ dtr: true, rts: false });
        await sleep(60);
        connB.set_remote({ dtr: false, rts: false });
        await sleep(120);

        expect(warnings.some((m): boolean => m.includes("cow-virtual-port") && m.includes("set conflict"))).toBe(true);

        rscA.disconnect();
        rscB.disconnect();
        try { server.close(); } catch { /* */ }
        await sleep(120);
    }, 15000);
});
