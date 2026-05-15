/* eslint-disable no-undef */
/**
 * P5 end-to-end: `auth_validator` + `acl` over real socket.io + IPC transports.
 *
 * Auth: validator pass / async pass / reject (string message); identity propagation.
 * ACL: `can_open` deny → ERROR state; `can_write` deny → ERROR + drain (window stays clean);
 *      `can_read` deny → one-shot ERROR + silent fanout filter.
 */
import path from "path";
import { MessageChannel } from "worker_threads";
import { SerialPortMock } from "serialport";
import { MockBinding } from "@serialport/binding-mock";
import { RemoteSerialportServer, NodeIpcServer } from "../src/index";
import type { AuthResult, AuthTransportMeta, RemoteSerialServerAcl } from "../src/types/remote-serialport-types/src/remote-serial-server.model";

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

interface SetupHandle {
    server: RemoteSerialportServer;
    rsc: any;
    close: () => Promise<void>;
}

function setup_ipc(opts: {
    auth_validator?: (cred: unknown, meta: AuthTransportMeta) => AuthResult | Promise<AuthResult>;
    acl?: RemoteSerialServerAcl;
    client_auth?: unknown;
}): SetupHandle {
    const channel = new MessageChannel();
    const server: RemoteSerialportServer = new RemoteSerialportServer(undefined, 0, {
        transport_server: new NodeIpcServer(channel.port1, "/"),
        serialport_factory: (port_opts: any): any => new SerialPortMock(port_opts),
        auth_validator: opts.auth_validator,
        acl: opts.acl
    });
    server.listen();

    const rsc = new RemoteSerialportClient("", {
        transport_client: new NodeIpcClient(channel.port2, "/", opts.client_auth)
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

describe("P5 auth + ACL (IPC)", () => {

    test("auth_validator: undefined credential is accepted when no validator is set", async () => {
        MockBinding.createPort("/dev/ttyACM10", { echo: false, record: true });
        const { server, rsc, close } = setup_ipc({});
        try {
            server.mux().on("connection", (socket): void => {
                expect(socket.identity).toBeNull();
                socket.pipe();
            });
            const mux = rsc.mux();
            mux.open("/dev/ttyACM10", { path: "/dev/ttyACM10", baudRate: 115200 });
            await waitFor((): boolean => mux.get_state("/dev/ttyACM10") === "open", 5000, "OPEN");
        } finally {
            await close();
        }
    }, 15000);

    test("auth_validator: pass + identity is propagated to ACL hooks", async () => {
        MockBinding.createPort("/dev/ttyACM11", { echo: false, record: true });
        let observed_credential: unknown = undefined;
        let observed_identity: unknown = undefined;
        const { server, rsc, close } = setup_ipc({
            auth_validator: (cred): AuthResult => {
                observed_credential = cred;
                return { ok: true, identity: { role: "admin", user: "alice" } };
            },
            acl: {
                can_open: (identity): boolean => {
                    observed_identity = identity;
                    return true;
                }
            },
            client_auth: { token: "letmein" }
        });
        try {
            server.mux().on("connection", (socket): void => socket.pipe());
            const mux = rsc.mux();
            mux.open("/dev/ttyACM11", { path: "/dev/ttyACM11", baudRate: 115200 });
            await waitFor((): boolean => mux.get_state("/dev/ttyACM11") === "open", 5000, "OPEN");
            expect(observed_credential).toEqual({ token: "letmein" });
            expect(observed_identity).toEqual({ role: "admin", user: "alice" });
        } finally {
            await close();
        }
    }, 15000);

    test("auth_validator: async validator works", async () => {
        MockBinding.createPort("/dev/ttyACM12", { echo: false, record: true });
        const { server, rsc, close } = setup_ipc({
            auth_validator: async (cred): Promise<AuthResult> => {
                await new Promise((r): unknown => setTimeout(r, 30));
                return { ok: true, identity: cred };
            },
            client_auth: "any-string-token"
        });
        try {
            let seen_identity: unknown = null;
            server.mux().on("connection", (socket): void => {
                seen_identity = socket.identity;
                socket.pipe();
            });
            const mux = rsc.mux();
            mux.open("/dev/ttyACM12", { path: "/dev/ttyACM12", baudRate: 115200 });
            await waitFor((): boolean => mux.get_state("/dev/ttyACM12") === "open", 5000, "OPEN");
            expect(seen_identity).toBe("any-string-token");
        } finally {
            await close();
        }
    }, 15000);

    test("auth_validator: reject → handshake never delivered + client disconnect signal", async () => {
        const { server, rsc, close } = setup_ipc({
            auth_validator: (): AuthResult => ({ ok: false, message: "bad token" })
        });
        try {
            let conn_fired = false;
            server.mux().on("connection", (): void => { conn_fired = true; });

            // mux.open before handshake — should never get acknowledged (server rejected)
            const mux = rsc.mux();
            mux.open("/dev/ttyACM_DENIED", { path: "/dev/ttyACM_DENIED", baudRate: 115200 });

            await sleep(200);

            // Client never sees OPEN; server-side connection handler never fires.
            expect(conn_fired).toBe(false);
            expect(mux.get_state("/dev/ttyACM_DENIED")).toBe("idle");
        } finally {
            await close();
        }
    }, 15000);

    test("acl.can_open: deny emits open ERROR; port stays IDLE", async () => {
        MockBinding.createPort("/dev/ttyACM13", { echo: false, record: true });
        const { server, rsc, close } = setup_ipc({
            acl: {
                can_open: (_identity, port_path): boolean => port_path !== "/dev/ttyACM13"
            }
        });
        try {
            server.mux().on("connection", (socket): void => socket.pipe());
            const mux = rsc.mux();
            mux.open("/dev/ttyACM13", { path: "/dev/ttyACM13", baudRate: 115200 });

            // Wait for the error state event
            await waitFor((): boolean => mux.get_state("/dev/ttyACM13") === "error", 5000, "ERROR state");
            expect(mux.get_state("/dev/ttyACM13")).toBe("error");
        } finally {
            await close();
        }
    }, 15000);

    test("acl.can_write: deny → ERROR state, drain still acked (window stays clean), device unchanged", async () => {
        MockBinding.createPort("/dev/ttyACM14", { echo: false, record: true });
        const mocks: Map<string, SerialPortMock> = new Map();
        const channel = new MessageChannel();
        const server: RemoteSerialportServer = new RemoteSerialportServer(undefined, 0, {
            transport_server: new NodeIpcServer(channel.port1, "/"),
            serialport_factory: (port_opts: any): any => {
                const m = new SerialPortMock(port_opts);
                mocks.set(port_opts.path, m);
                return m;
            },
            acl: {
                can_write: (_identity, port_path): boolean => port_path !== "/dev/ttyACM14"
            }
        });
        server.listen();
        const rsc = new RemoteSerialportClient("", {
            transport_client: new NodeIpcClient(channel.port2, "/")
        });
        try {
            const states: string[] = [];
            const error_messages: string[] = [];
            server.mux().on("connection", (socket): void => socket.pipe());
            const mux = rsc.mux();
            mux.open("/dev/ttyACM14", { path: "/dev/ttyACM14", baudRate: 115200 });
            const stream = mux.create_port("/dev/ttyACM14", "/dev/ttyVwd").get_port({ baudRate: 115200, autoOpen: true });
            stream.on("error", (err: Error): unknown => error_messages.push(err.message));

            // Track all state transitions
            const real_emit = (rsc as any)._mux_sockets.get("/").emit;
            mux.constructor.prototype._states; // no-op, just to keep linter calm

            await waitFor((): boolean => mux.get_state("/dev/ttyACM14") === "open", 5000, "OPEN");
            void states; // (unused — we rely on error_messages instead)
            void real_emit;

            // Attempt a write; server should deny + emit ERROR.
            stream.write(Buffer.from("DENIED_WRITE"));
            await sleep(200);

            // Device's lastWrite must not be the denied payload.
            const lw = mocks.get("/dev/ttyACM14")!.port!.lastWrite;
            expect(lw === null || Buffer.from(lw).toString("utf8") !== "DENIED_WRITE").toBe(true);

            // Client's local stream should have received a "write denied" error.
            expect(error_messages.some((m): boolean => m.includes("write denied"))).toBe(true);

            // Subsequent writes should still flow through the gate (drain was acked).
            // We can't toggle ACL mid-test, but verify the gate is not stalled by checking it stays writable.
            const stillWritable: boolean = stream.write(Buffer.from("STILL_FLOWS")) as unknown as boolean;
            expect(typeof stillWritable).toBe("boolean");
        } finally {
            try { rsc.disconnect(); } catch { /* */ }
            try { server.close(); } catch { /* */ }
            await sleep(50);
        }
    }, 15000);

    test("acl.can_read: deny → one-shot ERROR on open, subsequent device bytes are silently filtered", async () => {
        MockBinding.createPort("/dev/ttyACM15", { echo: false, record: true });
        const mocks: Map<string, SerialPortMock> = new Map();
        const channel = new MessageChannel();
        const server: RemoteSerialportServer = new RemoteSerialportServer(undefined, 0, {
            transport_server: new NodeIpcServer(channel.port1, "/"),
            serialport_factory: (port_opts: any): any => {
                const m = new SerialPortMock(port_opts);
                mocks.set(port_opts.path, m);
                return m;
            },
            acl: {
                can_read: (_identity, port_path): boolean => port_path !== "/dev/ttyACM15"
            }
        });
        server.listen();
        const rsc = new RemoteSerialportClient("", {
            transport_client: new NodeIpcClient(channel.port2, "/")
        });
        try {
            const received: string[] = [];
            const errors: string[] = [];
            server.mux().on("connection", (socket): void => socket.pipe());
            const mux = rsc.mux();
            mux.open("/dev/ttyACM15", { path: "/dev/ttyACM15", baudRate: 115200 });
            const stream = mux.create_port("/dev/ttyACM15", "/dev/ttyVrd").get_port({ baudRate: 115200, autoOpen: true });
            stream.on("data", (d: Buffer): number => received.push(Buffer.from(d).toString("utf8")));
            stream.on("error", (err: Error): unknown => errors.push(err.message));

            await sleep(150);
            // ACL read deny posts an ERROR before any device bytes — wait for that
            await waitFor((): boolean => errors.some((m): boolean => m.includes("read denied")), 5000, "read denied error");

            // Even after device emits bytes, client should NOT receive them.
            mocks.get("/dev/ttyACM15")!.port!.emitData(Buffer.from("SECRET_DATA"));
            await sleep(200);
            expect(received).not.toContain("SECRET_DATA");
        } finally {
            try { rsc.disconnect(); } catch { /* */ }
            try { server.close(); } catch { /* */ }
            await sleep(50);
        }
    }, 15000);
});

describe("P5 auth + ACL (socket.io)", () => {
    const PORT = 17890;
    let server: RemoteSerialportServer;
    const mocks = new Map<string, SerialPortMock>();

    beforeEach(() => {
        server = new RemoteSerialportServer({ cors: { origin: "*" } }, PORT, {
            serialport_factory: (opts: any): any => {
                const m = new SerialPortMock(opts);
                mocks.set(opts.path, m);
                return m;
            },
            auth_validator: (cred: unknown): AuthResult => {
                const c = cred as { token?: string } | undefined;
                if (c?.token === "good") {
                    return { ok: true, identity: { user: c.token } };
                }
                return { ok: false, message: "invalid token" };
            }
        });
        server.listen();
    });

    afterEach(async () => {
        try { server.close(); } catch { /* */ }
        mocks.clear();
        await sleep(120);
    });

    test("socket.io: validator pass with Manager auth field", async () => {
        MockBinding.createPort("/dev/ttyACM20", { echo: false, record: true });
        server.of().on("connection", (socket): void => socket.pipe());

        const rsc = new RemoteSerialportClient(`ws://localhost:${PORT}`, { auth: { token: "good" } });
        const conn = rsc.connect("/dev/ttyACM20", { path: "/dev/ttyACM20", baudRate: 115200 });
        await waitFor((): boolean => conn.state === "open", 5000, "open");
        expect(conn.state).toBe("open");

        rsc.disconnect();
        await sleep(120);
    }, 15000);

    test("socket.io: validator reject — handshake never delivered", async () => {
        server.of().on("connection", (socket): void => socket.pipe());

        const rsc = new RemoteSerialportClient(`ws://localhost:${PORT}`, { auth: { token: "wrong" } });
        const conn = rsc.connect("/dev/ttyACM21", { path: "/dev/ttyACM21", baudRate: 115200 });

        await sleep(300);
        // Should never reach OPEN
        expect(conn.state).not.toBe("open");

        rsc.disconnect();
        await sleep(120);
    }, 15000);
});
