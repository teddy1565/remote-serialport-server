# Remote-Serialport

> **Language**: [English](#english) · [中文](#中文)

<a id="english"></a>

## English

> **⚠ Node.js only.** This library uses Node's `Buffer`, `worker_threads`, `node:http2`, the
> native `serialport` binding, and other Node-specific APIs. It **does not work in browsers**
> — bundling it via webpack / Vite / Rollup will fail at `Buffer`/`stream`/`net` imports.
> Even though socket.io and `ws` themselves have browser builds, this library is the *Node
> side* of a Node↔Node deployment. For a browser front-end, write a thin app-layer adapter
> against your own WebSocket / WebRTC and forward bytes — don't try to load this package in
> the browser.

Proxy a host's physical serial ports over the network: the **server** holds the real serial ports;
the **client** connects and gets a local *virtual* serial port (a mock-binding–backed
`SerialPortStream`) that mirrors a remote one. Reads/writes on the virtual port are forwarded to the
physical port, and vice versa — so existing Node serialport code (`serialport`, `modbus-serial`, …)
works across the network with almost no changes.

This project is split into three packages:

| Package | npm | Role |
|---|---|---|
| [`remote-serialport-types`](https://github.com/teddy1565/remote-serialport-types) | `remote-serialport-types` | Shared protocol types & abstract contracts (consumed by the other two via git submodule). |
| [`remote-serialport-server`](https://github.com/teddy1565/remote-serialport-server) | `node-serialport-server` | Owns the physical serial ports; exposes them over socket.io. |
| [`remote-serialport-client`](https://github.com/teddy1565/remote-serialport-client) | `node-serialport-client` | Connects to the server; surfaces remote ports as local virtual ports. |

> **Developing from source?** The `types` package is included as a git submodule under
> `src/types/remote-serialport-types`. After `git submodule update --init`, run `npm install` **inside
> that submodule directory too** (it has its own dependencies) so `tsc` resolves all types.

## Two modes

- **Namespace mode** — one socket.io namespace = one remote serial port. `client.connect("/dev/ttyUSB0", …)`.
  Simple and socket.io-idiomatic. Multiple `connect()` calls reuse the client's single transport
  connection (socket.io namespace multiplexing), so one connection can still carry many ports.
- **Mux mode** — one connection on a "mux namespace" carries any number of remote ports, addressed
  dynamically by `path` inside the messages. For cases where you don't want a namespace per port
  (e.g. IoT mesh, dynamic addressing). `client.mux("/site-A").open("/dev/ttyUSB0", …)`.

The two modes share the same protocol shape; the only difference is whether the socket itself
identifies the port (namespace mode, payloads are raw bytes) or each payload carries a `path`
(mux mode).

## Install

```bash
npm install node-serialport-server   # server
npm install node-serialport-client   # client
```

## Server

### Namespace mode

```javascript
const { RemoteSerialportServer } = require("node-serialport-server");

const server = new RemoteSerialportServer(
  { cors: { origin: "*", methods: ["GET", "POST"] } }, // socket.io ServerOptions
  17991,                                               // port
  { auto_pipe: true /* , strict_path, serialport_factory, ... */ }
);
server.listen();

// REQUIRED: register an `on("connection", ...)` listener — even if its body is empty.
// Without this call, the underlying socket.io namespace's `connection` handler is never
// wired, and the server accepts TCP connections but never instantiates the per-connection
// wrapper — so auth, ACL, `auto_pipe` and port routing do NOT run. (Library logs a `warn`
// 1.5 s after `listen()` if no listener is registered.)
server.of().on("connection", (socket) => {
  // With `auto_pipe: true` you can leave this empty. Add hooks here only if you need to
  // observe / transform bytes in transit:
  // socket.port.on("data", (chunk) => console.log("device says", chunk));
  // socket.port.on("write-command", (chunk) => console.log("client wrote", chunk));
});

// Without `auto_pipe`, call `socket.pipe()` yourself inside the connection handler.
// (Don't both `pipe()` AND re-emit `serialport_packet` manually — data would be forwarded twice.)
```

> **Gotcha: `auto_pipe: true` is not "set and forget."** It enables the *post-handshake*
> auto-pipe step on each accepted socket, but the namespace's *socket.io connection event*
> only gets wired when you call `server.of(...).on("connection", listener)`. An empty
> `() => {}` listener is enough; missing the call entirely will silently drop every client.
> The 1.5-second post-`listen()` warning catches this in dev; ship code should still register
> explicitly.

All `RemoteSerialServerOptions`:

| Option | Default | What it does |
|---|---|---|
| `serialport_namespace_regexp` | `/^(\/dev\/tty(USB\|AMA\|ACM)\|\/COM)[0-9]+$/` | Regex namespaces must match to be accepted as serial-port paths. Override to allow custom paths like `/dev/ttyMODBUS` or `/dev/ttyUSB100` (the default's `[0-9]+$` tail rejects suffixes that aren't pure digits). |
| `strict_path` | `true` | If `false`, namespace is just a routing label and client's `options.path` is used (still regexp-validated). |
| `auto_pipe` | `false` | If `true`, every accepted connection auto-`pipe()`s (read direction). Recommended for the common "pure relay" case — keeps the `connection` handler empty. |
| `serialport_factory` | `(opts) => new SerialPort(opts)` | Inject a mock-backed factory in tests. |
| `port_list_provider` | `() => SerialPort.list()` | Override what `serialport_list` RPC returns. **Pair with `serialport_factory` in tests**: real `SerialPort.list()` doesn't see `SerialPortMock` ports, so if you mock the factory you usually need to mock this too. |
| `logger` | warn/error → console, debug/info silent | Inject pino / winston / your own `Logger` (see below). |
| `multi_access` | `'reject'` | `'shared'` lets multiple clients connect to the same physical path (refcounted). |
| `shared_mode` | `'fifo'` | Only used when `multi_access='shared'`. See [Shared mode](#shared-mode-multi_access-shared). |
| `cow_snapshot_buffer_bytes` | `65536` | Ring buffer size for `shared_mode: 'cow-snapshot'`. |
| `txn_timeout_ms` | `5000` | Per-transaction timeout; reset on each `serialport_send_chunk`. Drops buffered chunks if no `_end`/`_abort` arrives. |
| `txn_timeout_action` | `'log'` | `'log'` / `'state'` (also emit `serialport_state: ERROR`) / `'both'`. |
| `auth_validator` | — | Credential validator. See [Authentication and ACL](#authentication-and-acl-auth_validator--acl). |
| `acl` | — | Per-operation hooks (`can_open` / `can_write` / `can_read`). See [Authentication and ACL](#authentication-and-acl-auth_validator--acl). |
| `transport_server` | `new SocketIoServer(...)` | Inject a custom transport (e.g. `NodeIpcServer`). See [Transports](#transports-abstransport). |

### Mux mode

```javascript
server.mux().on("connection", (socket) => {
  socket.pipe(); // forward reads for every port on this connection (existing and future)
  // Per-port proxies: socket.port("/dev/ttyUSB0").on("data", …)
});
```

`server.mux("/site-A")` (or a regexp) to use a specific / dynamic mux namespace; default `/`.

## Client

### Namespace mode — auto open

```javascript
const { RemoteSerialportClient } = require("node-serialport-client");
const { ByteLengthParser } = require("serialport");

const rsc = new RemoteSerialportClient("ws://localhost:17991");

// connect to the remote port (the 1st arg is the socket.io namespace; options.path is the real
// remote serial path — usually the same string). The port is opened automatically after handshake.
const conn = rsc.connect("/dev/ttyUSB0", { path: "/dev/ttyUSB0", baudRate: 115200 });

// map the remote port to a local virtual port path and get a SerialPortStream-compatible object
const port = conn.create_port("/dev/ttyV0").get_port({ baudRate: 115200, autoOpen: true });

port.pipe(new ByteLengthParser({ length: 30 })).on("data", (data) => console.log(data));
port.write(Buffer.from([0x01, 0x02, 0x03])); // forwarded to the remote physical port

console.log(conn.state); // "idle" | "opening" | "open" | "closing" | "closed" | "error"
```

### Namespace mode — manual open

```javascript
const conn = rsc.connect("/dev/ttyUSB0");      // connect only, don't open yet
// ...later...
conn.open({ path: "/dev/ttyUSB0", baudRate: 9600 });
```

### With modbus-serial

```javascript
const ModbusRTU = require("modbus-serial");
const rsc = new RemoteSerialportClient("ws://localhost:17991");
const conn = rsc.connect("/dev/ttyUSB0", { path: "/dev/ttyUSB0", baudRate: 9600 });
const port = conn.create_port("/dev/ttyV0").get_port({ baudRate: 9600 });

const modbus = new ModbusRTU(port);
modbus.setID(1);
modbus.readHoldingRegisters(3, 2).then(console.log).catch(console.error);
```

### Mux mode

```javascript
const mux = rsc.mux();                 // or rsc.mux("/site-A")
mux.open("/dev/ttyUSB0", { path: "/dev/ttyUSB0", baudRate: 115200 });
mux.open("/dev/ttyACM0", { path: "/dev/ttyACM0", baudRate: 9600 });

const portA = mux.create_port("/dev/ttyUSB0", "/dev/ttyVA").get_port({ baudRate: 115200, autoOpen: true });
const portB = mux.create_port("/dev/ttyACM0", "/dev/ttyVB").get_port({ baudRate: 9600, autoOpen: true });

console.log(mux.get_state("/dev/ttyUSB0"));
```

### Remote port control / discovery (RPC)

These act on the *physical* port on the server (the local virtual port's own `set/get/update/flush`
still go to the local mock binding and are unaffected). `get`/`list` return a `Promise`
(socket.io ack under the hood, ~5s timeout).

```javascript
const ports  = await conn.list_ports();          // PortInfo[] — server host's SerialPort.list()
const status = await conn.get_remote_status();   // { cts, dsr, dcd } of the real port
conn.set_remote({ dtr: true, rts: false });      // toggle modem control lines on the real port
conn.update_remote({ baudRate: 9600 });          // change baud rate on the real port
conn.flush_remote();                             // discard the real port's buffers

// mux variants take the remote path (list_ports is server-wide, no path):
const muxStatus = await mux.get_remote_status("/dev/ttyUSB0");
mux.set_remote("/dev/ttyUSB0", { dtr: true });
const muxPorts  = await mux.list_ports();
```

The server reads the port list from `() => SerialPort.list()` by default; pass `port_list_provider`
in the server options to override (e.g. in tests, where `SerialPort.list()` doesn't see mock ports).

### Multiple servers

```javascript
const { RemoteSerialportServerManager } = require("node-serialport-server");
const mgr = new RemoteSerialportServerManager();
mgr.create("line-A", { cors: { origin: "*" } }, 17991);
mgr.create("modbus", { cors: { origin: "*" } }, 17992);
mgr.listen_all();
// mgr.get("line-A"), mgr.servers, mgr.close_all()
```

### Disconnect

```javascript
rsc.disconnect("/dev/ttyUSB0"); // one socket
rsc.disconnect();               // everything + drop all virtual ports + reset mock registry
```

### Multi-chunk transactions (txn)

For writes that span multiple chunks and must be atomic on the device side (e.g. one Modbus PDU sent
as several pieces; network may delay/drop chunks; the server must not write partial bytes).

```javascript
const portInst = conn.create_port("/dev/ttyV0");

// build the transaction; server starts buffering on .txn() (sends serialport_send_begin)
const tx = portInst.txn();
tx.write(Buffer.from([0x01, 0x03]));
tx.write(Buffer.from([0x00, 0x00, 0x00, 0x02]));
await tx.end(); // Promise resolves when the FULL buffer has drained on the physical port

// scoped: auto end on success, auto abort on throw
await portInst.with_txn(async (tx) => {
  tx.write(part1);
  if (some_error) throw new Error("rollback"); // auto-aborts; bytes never reach device
  tx.write(part2);
});
```

- Server-side timeout (`txn_timeout_ms`, default 5s, **resets on every chunk**) drops buffered chunks
  if no `_end` / `_abort` arrives.
- Only `_end` consumes a slot in the client's send window; `_begin` / `_chunk` / `_abort` are free.

### Logger

`RemoteSerialServerOptions.logger` (server) and `RemoteSerialportClientOptions.logger` (client)
accept any object matching:

```typescript
interface Logger {
  debug(message: string, ...meta: unknown[]): void;
  info(message: string, ...meta: unknown[]): void;
  warn(message: string, ...meta: unknown[]): void;
  error(message: string, ...meta: unknown[]): void;
}
```

Default: `warn` / `error` to `console`, `debug` / `info` discarded. Plug in pino/winston/etc. for
production logging.

### Reconnect behavior (client)

Both `connect()` and `mux()` survive transport drops:

- **Namespace mode**: `_open_options` is preserved; on reconnect the client auto-replays
  `serialport_open` after the handshake. The server reopens the physical port.
- **Mux mode**: every `mux.open(remote_path, options)` is persisted in an `_active_opens` map and
  replayed on every reconnect. Removed only by `mux.close(remote_path)` or `rsc.disconnect()`.
- **In-flight RPCs** (`get_remote_status` / `list_ports`): replayed on reconnect with the **original
  deadline** (not reset). Configure via the constructor:

```javascript
const rsc = new RemoteSerialportClient("ws://localhost:17991", {
  logger: my_logger,
  rpc: { timeout_ms: 5000, replay_on_reconnect: true }, // defaults shown
  txn_id_allocator: "counter", // or "uuid" or () => string
});
```

### Shared mode (`multi_access: 'shared'`)

Multiple clients can connect to the same physical path; the server refcounts one
`SharedPortSession` per path. Works for both namespace mode and mux mode; a namespace client and a
mux client on the same `path` share the same underlying physical port.

```javascript
const server = new RemoteSerialportServer({ cors: { origin: "*" } }, 17991, {
  multi_access: "shared",
  shared_mode: "fifo", // or "fifo-strict" / "batch" / "pipe"
});
```

| `shared_mode` | Write scheduling | Reads |
|---|---|---|
| `'fifo'` (default) | Strict by `_begin` arrival order; head-of-line blocking (B's `_end` arriving first does NOT cut in front of A whose `_begin` arrived earlier). | Fan-out to all subscribers. |
| `'fifo-strict'` | Same as `'fifo'` + only one in-flight write at a time across all clients (server stop-and-wait). | Fan-out. |
| `'batch'` | Immediate flush on `_end`/single-shot arrival — `_end`-order on the wire, no HOL. | Fan-out. |
| `'pipe'` | First-connected client is writer; others are read-only (their writes are dropped, drain still acked). Writer disconnect → next-earliest client auto-promoted, gets `serialport_state: OPEN, message: 'promoted to writer (pipe mode)'`. | Fan-out. |
| `'cow-write-isolate'` | Immediate flush; server remembers each subscriber's recent writes and routes prefix-matching device bytes only to the originator. | Echo-filtered fan-out: matched bytes → writer only; unmatched → everyone. |
| `'cow-snapshot'` | Immediate flush. | Fan-out + per-subscriber **catch-up**: a new subscriber receives the ring buffer (`cow_snapshot_buffer_bytes`, default 64 KB) as `serialport_packet`s before live forwarding begins. |
| `'cow-virtual-port'` | Immediate flush + per-subscriber `set`/`update` state cache (last-write-wins on the physical port; library logs a `warn` on conflict). | Fan-out. |

Writer policy + scheduling are *per-path*. Drain acks for each write route back to the originating
client only (no cross-client window stalls).

**`cow-write-isolate` caveat:** the echo filter is byte-level prefix matching. Devices that
transform written bytes before echoing (line-ending translation, transcoding, etc.) defeat the
filter — those unmatched bytes fall through to the global fanout and are observed by every
subscriber. Best for line-echo or full-duplex devices that emit verbatim back; don't rely on it
for true byte-level isolation.

**Hooking `socket.port` in shared mode:** the per-`socket` `port` exposed in the `connection`
handler is the **shared** physical-port `EventEmitter`, not a per-subscriber view. So
`socket.port.on("data", …)` and `socket.port.on("write-command", …)` fire **once per event for
every subscriber socket that installed the listener** — and any closure variables (`socket.identity`,
the user tag you captured) refer to the listener-installing socket, not the writing client.
Practical patterns:

```javascript
// WRONG in shared mode: installs N listeners, each fires for every write,
// and `id.user` tags writes with the wrong subscriber.
server.of().on("connection", (socket) => {
  const id = socket.identity;
  socket.port.on("write-command", (chunk) => log(`${id.user} wrote ${chunk}`));
});

// Right: install once, treat the chunk as anonymous (no per-write identity).
let installed = false;
server.of().on("connection", (socket) => {
  if (installed) return; installed = true;
  socket.port.on("write-command", (chunk) => log(`someone wrote ${chunk}`));
});
```

If you need writer attribution in shared mode today, gate writes through `acl.can_write` (which
*is* called per-subscriber with the originator's `identity`) and record there. A `subscriber_id`
argument on `write-command` listeners is a candidate API for a future minor version.

**Testing shared mode with `SerialPortMock`:** when the last subscriber leaves, the
`SharedPortSession` closes the underlying physical port. If your test harness captured the mock
via `serialport_factory` to push synthetic device output, that captured handle is now closed and
`emitData(...)` throws `Port must be open to pretend to receive data`. The next subscriber gets
a **fresh** mock via the factory — so don't capture once; re-capture on every factory
invocation, and guard `emitData` calls with `mock.isOpen` plus a try/catch:

```javascript
let captured = null;
new RemoteSerialportServer({}, 0, {
  multi_access: "shared", shared_mode: "fifo",
  serialport_factory: (opts) => { const m = new SerialPortMock(opts); captured = m; return m; }
});
setInterval(() => {
  if (captured === null || captured.isOpen === false) return;
  try { captured.port.emitData(buf); } catch { /* port flipped to closed between check + emit */ }
}, 400);
```

### Authentication and ACL (`auth_validator` + `acl`)

```javascript
const server = new RemoteSerialportServer({ cors: { origin: "*" } }, 17991, {
  auth_validator: async (credential, meta) => {
    // credential is whatever the client put in its `auth` field (JWT, API key, ...).
    // `meta` = { transport_id, endpoint_label }.
    const user = await my_verify(credential);
    if (user === null) return { ok: false, message: "bad token" };
    return { ok: true, identity: user };  // attached to socket.identity for ACL hooks
  },
  acl: {
    can_open: (identity, path) => identity.role === "admin" || allowed_paths_for(identity).includes(path),
    can_write: (identity, path) => identity.role !== "viewer",
    can_read:  (identity, path) => true
  }
});
```

`auth_validator` runs once per accepted transport (and again on socket.io reconnect, since
`Manager({auth})` is replayed automatically). Rejection sends `serialport_state: ERROR { message }`
and closes the transport — the user's `connection` handler never fires for that socket.

The `acl` hooks gate **per-operation**:

| Hook | Trigger | Deny effect |
|---|---|---|
| `can_open(identity, path)` | client's `serialport_open` / `serialport_mux_open` | `serialport_state: ERROR { message: "open denied: ..." }`. Port stays IDLE. |
| `can_write(identity, path)` | every write-direction message: `_send_packet`, `_send_begin`, `_send_end`, `_set`, `_update`, `_flush` | `serialport_state: ERROR { message: "write denied: ..." }` + `serialport_drain` (so the client's backpressure window stays clean). Bytes are dropped before reaching the device. |
| `can_read(identity, path)` | once per `open` | one-shot `serialport_state: ERROR { message: "read denied: ..." }` + silent filter on subsequent device→client packets for this client. |

The client surfaces `ERROR` states through the local virtual stream's `'error'` event, so
unmodified existing serialport code reacts to deny states the same way it does to device errors.

#### Encryption / TLS

This library doesn't wrap transports in TLS itself. For each transport:

- **socket.io**: build your own `https.Server` and attach the library's socket.io instance to it
  via the public `srv.io` accessor — do NOT call `srv.listen()` afterwards (it would create a
  second plain-HTTP listener):

  ```javascript
  const httpsServer = require("https").createServer({ key, cert });
  const srv = new RemoteSerialportServer({ cors: { origin: "*" } }, 17991, { /* ... */ });
  srv.io.attach(httpsServer);                       // attach socket.io to https
  srv.of("/dev/ttyUSB0").on("connection", () => {});  // friction#9 — still required
  httpsServer.listen(17991);                        // listen on https
  // (skip srv.listen() in this mode)
  ```
- **Raw TCP / Raw WebSocket / HTTP/2**: built-in `{ tls: ... }` option on the transport ctor.
- **gRPC**: built-in `credentials` option; pass `grpc.ServerCredentials.createSsl(...)`.
- **MQTT**: connect to an `mqtts://` broker URL; pass any TLS options the `mqtt` lib accepts via
  `mqtt_options`.
- **WebRTC**: SCTP-over-DTLS-over-ICE is always encrypted by spec — no app-layer cert plumbing.
- **IPC**: OS-level sandbox / process isolation.

mTLS for socket.io: pass `{requestCert: true, ca, ...}` to `https.createServer(...)`.

### Wire backpressure (device→client)

When `socket.pipe()` is forwarding physical bytes faster than the client can drain them, the
server samples the underlying socket.io transport's `bufferedAmount` after each emit and `pause()`s
the physical port once it crosses `WIRE_BACKPRESSURE_HIGH_WATER` (1 MB). A periodic check
(`WIRE_BACKPRESSURE_POLL_MS`, 50 ms) `resume()`s it once the buffer falls below
`WIRE_BACKPRESSURE_LOW_WATER` (256 KB). Only active in `multi_access: 'reject'` mode — shared mode
pause/resume would starve other subscribers, so it's disabled there. IPC transports report
`get_buffered_amount()` as `null`, so wire backpressure is skipped on IPC.

### Transports (`AbsTransport`)

The wire protocol is transport-agnostic. The default transport is **socket.io** (TCP/WebSocket);
a second built-in transport speaks **Node IPC** (`worker_threads.MessagePort` / Electron utility
process `MessagePortMain`). Swap by injecting `transport_server` into the constructor.

> **IPC `label` is the serial port path.** `new NodeIpcServer(port, label)` — the `label`
> argument becomes the transport's `endpoint_label`, which becomes the implicit `serialport_path`
> for sockets on this IPC pair. So in namespace mode, pass the actual device path
> (e.g. `"/dev/ttyUSB0"`, `"COM3"`), **not** a debug name. (`server.of(label).on("connection", …)`
> on an IPC server does *not* route by label — there is only one connection per IPC pair — so
> the constructor `label` is the only place the path is set.) In **mux mode** the label is unused
> for routing; pass anything readable (the path comes from each `open()` payload).

```typescript
import { MessageChannel } from "worker_threads";
import { RemoteSerialportServer, NodeIpcServer } from "node-serialport-server";

const channel = new MessageChannel();
const server = new RemoteSerialportServer(undefined, 0, {
    // Namespace mode: `label` IS the serial port path. Pass the device path here.
    transport_server: new NodeIpcServer(channel.port1, "/dev/ttyUSB0"),
    serialport_factory: (opts) => new SerialPort(opts),
    auto_pipe: true
});
server.listen(); // no-op on IPC
server.of().on("connection", (socket) => {
  console.log("client opened", socket.serialport_path); // "/dev/ttyUSB0"
});
// pass channel.port2 to the consumer process / utility / worker via postMessage / Worker workerData
```

The client side is symmetric — inject `NodeIpcClient(port, label)` (same rule: namespace mode
`label` = device path) via `transport_client`. See
[client README](../remote-serialport-client/README.md#transports-abstransport).

IPC transport differences vs socket.io:

| Behavior | socket.io | Node IPC |
|---|---|---|
| Reconnect | auto-reconnect, client RPC replay | no reconnect — port pair is single-shot |
| Wire backpressure | sampled via `bufferedAmount` | `get_buffered_amount()` returns `null`; skipped |
| Endpoint multiplexing | one namespace per `of(label)` | single endpoint per IPC pair; **use mux mode** for many ports |
| Connection model | many clients → server | one peer pair per server instance |

Use IPC when both sides live in the same Node process tree (worker threads, Electron utility
process). Use socket.io for cross-host / cross-network.

#### Raw TCP / Unix Domain Socket / Named Pipe (`RawTcpServer`)

A length-prefix-framed JSON envelope transport over `net.Socket`. Use when you want minimal
dependency footprint, run on a closed LAN where you don't need socket.io's HTTP polling
fallback, or want to talk through an OS-level pipe (UDS / Named Pipe) instead of TCP.

```javascript
const { RemoteSerialportServer, RawTcpServer } = require("node-serialport-server");

// Plain TCP, mux mode (default — many namespaces share one connection)
new RemoteSerialportServer(undefined, 0, {
    transport_server: new RawTcpServer({ port: 17993 }),
    auto_pipe: true
});

// TLS over TCP
new RawTcpServer({ port: 17994 }, { tls: { key, cert } });

// 1-to-1 (one connection per namespace, IPC-like)
new RawTcpServer({ port: 17995 }, { mode: "single-namespace" });

// UDS (Linux/Mac) / Named Pipe (Windows) — `path` instead of `port`
new RawTcpServer({ path: "/tmp/rsp.sock" });                  // *nix
new RawTcpServer({ path: "\\\\.\\pipe\\rsp" });               // Windows
```

`RawTcpServerOptions`:

| Option | Default | What it does |
|---|---|---|
| `mode` | `"mux"` | `"mux"`: 1 TCP connection multiplexes many namespaces via envelope `ns` field (socket.io-like). `"single-namespace"`: 1 TCP connection = 1 namespace, bound at hello time (IPC-like). |
| `tls` | — | `tls.TlsOptions` (`{ key, cert, ca, ... }`). Pass to enable TLS; omit for plain TCP. Ignored when target uses `path:` (UDS / Named Pipe have no TLS concept — file permissions are the security boundary). |
| `keep_alive` | `true` (30 s) | TCP keepalive. `false` disables; `{ initial_delay_ms }` customises. |
| `permissions` | — | Octal `chmod` for UDS path after `listen()` (e.g. `0o660`). No-op for TCP / Pipe. |
| `logger` | default | Inject your `Logger`. |

**Wire format** (per frame): `[4 bytes BE total len][4 bytes BE json len][JSON envelope][optional binary tail]`. Binary tail carries Buffer payloads on hot channels (`serialport_packet`, mux/txn data) directly without JSON-encoding — avoids the 4 KB → 20 KB inflation that naïve JSON-of-Buffer suffers. Other envelopes are plain JSON.

**Transport differences** for Raw TCP vs the other built-ins:

| Behavior | socket.io | Node IPC | Raw TCP (plain/TLS) | Raw TCP (UDS / Pipe) |
|---|---|---|---|---|
| Reconnect | auto-reconnect, RPC replay | none (single-shot) | none (single-shot) | none (single-shot) |
| Wire backpressure | `bufferedAmount` sampling | `null` (skipped) | `socket.writableLength` | `socket.writableLength` |
| Endpoint multiplexing | one namespace per `of()` | single endpoint (use mux mode) | mode-controlled | mode-controlled |
| TLS | external (https.Server) | OS-level only | built-in `{ tls: ... }` | OS-level only (file perms) |
| Browser support | yes | no | no | no |

**Throughput / latency (localhost, Node 24, 4 KB device-emit chunks)**:

| | Throughput | RTT p50 / p99 |
|---|---|---|
| Raw WebSocket (mux, plain) | 44.16 MB/s | 0.46 / 2.33 ms |
| socket.io | 18.18 MB/s | 0.66 / 1.67 ms |
| HTTP/2 (h2c) | 16.92 MB/s | 0.48 / **1.48 ms** |
| WebRTC DataChannel (loopback, no NAT) | 12.79 MB/s | 0.67 / 3.35 ms |
| Raw TCP (mux, plain) | 11.72 MB/s | **0.40** / 3.71 ms |
| gRPC (insecure) | 6.80 MB/s | 1.34 / 14.87 ms |
| Node IPC (worker_threads) | 4.70 MB/s | n/a (single-process) |
| MQTT (aedes broker localhost) | 4.24 MB/s | 2.62 / 11.99 ms |

`ws` has tighter binary framing than Engine.IO; socket.io wins overall stability via its extra layers; HTTP/2 has the **best p99** (per-stream flow control = no head-of-line blocking); Raw TCP wins p50 by stack thinness. WebRTC localhost numbers don't reflect real-world deployment — add NAT/ICE/TURN cost in production. gRPC pays per-message protobuf overhead — middle of the pack on throughput, slower p99 from the extra framing. MQTT pays a broker round-trip per direction — slowest of the bunch, but you get pub-sub semantics and broker persistence for free.

#### Raw WebSocket (`RawWebSocketServer`)

Same envelope + framing as Raw TCP, but delivered over the `ws` library's WebSocket protocol.
Use when you want a TCP-only socket.io replacement (no HTTP polling fallback, no Engine.IO),
need browser clients, or want to share a port with an existing HTTP server (you can attach to
your own `http.Server` instead of letting the constructor make one).

```javascript
const { RemoteSerialportServer, RawWebSocketServer } = require("node-serialport-server");

// Plain ws://, mux mode (default)
new RemoteSerialportServer(undefined, 0, {
    transport_server: new RawWebSocketServer({ port: 17996 }),
    auto_pipe: true
});

// TLS (wss://)
new RawWebSocketServer({ port: 17997 }, { tls: { key, cert } });

// 1-to-1 namespace mode
new RawWebSocketServer({ port: 17998 }, { mode: "single-namespace" });

// Custom HTTP path (default "/")
new RawWebSocketServer({ port: 17999, path: "/rsp" });
```

`RawWebSocketServerOptions`:

| Option | Default | What it does |
|---|---|---|
| `mode` | `"mux"` | Same semantics as Raw TCP: `"mux"` shares one ws across many namespaces; `"single-namespace"` is 1 ws = 1 namespace. |
| `tls` | — | `tls.TlsOptions`. When set, the underlying HTTP server is upgraded to HTTPS and the URL becomes `wss://`. |
| `logger` | default | Inject your `Logger`. |

The client is `RawWebSocketClient` (see [client README](../remote-serialport-client/README.md#raw-websocket-rawwebsocketclient)).

#### HTTP/2 (`Http2Server`)

Uses Node's built-in `node:http2`. Each namespace = one HTTP/2 stream within a session, so
HTTP/2's native stream multiplexing IS the mux model — there is no `mode` option. Each stream
has its own flow-control window, which means a slow consumer on one namespace can't head-of-line
block traffic on another (best p99 of all built-in transports).

```javascript
const { RemoteSerialportServer, Http2Server } = require("node-serialport-server");

// h2 over TLS (recommended; ALPN "h2")
new RemoteSerialportServer(undefined, 0, {
    transport_server: new Http2Server({ port: 17996 }, { tls: { key, cert } }),
    auto_pipe: true
});

// h2c cleartext (trusted internal networks only — most non-Node clients refuse h2c)
new Http2Server({ port: 17997 });
```

`Http2ServerOptions`:

| Option | Default | What it does |
|---|---|---|
| `tls` | — | `http2.SecureServerOptions`. When set the server runs h2 over TLS with `allowHTTP1: false`. When absent the server runs h2c cleartext. |
| `logger` | default | Inject your `Logger`. |

The `:path` header on each incoming stream is treated as the namespace label. So `server.of("/dev/ttyUSB0").on("connection", ...)` matches client streams opened with `:path: /dev/ttyUSB0`. The client class (`Http2Client`) sets `:path` automatically from the `label` you pass to `open(label)`.

**Auth + the deferred-accept hello-gate**: the HTTP/2 server defers firing `endpoint.accept(transport)` until the client's first `hello` envelope arrives on the stream. That ensures `transport.credential` is populated with the client's `auth` payload before the wrapping `RemoteSerialServerSocket`'s `auth_validator(credential, meta)` runs — without this gate the validator would be called with `credential === undefined` because hello arrives microseconds after the stream is opened. Pass the credential into the client transport's own ctor (`new Http2Client({...}, { auth: ... })`), not the top-level `RemoteSerialportClient` options. (Duplicate `hello` envelopes on the same stream after the first are dropped with a `warn` log — a misbehaving client cannot upgrade its credential mid-session.)

#### MQTT broker pattern (`MqttServer`)

Connects to an external MQTT broker (mosquitto / EMQX / HiveMQ / aedes / NATS-MQTT / etc.) and
turns the broker into the wire. Topic conventions (default prefix `"rsp"`):

```text
<prefix>/c2s/<client_id>/<label>     client → server (incl. the `hello` envelope)
<prefix>/s2c/<client_id>/<label>     server → client
```

The server subscribes to `<prefix>/c2s/+/#` (multi-level wildcard catches labels containing `/`),
demultiplexes on `(client_id, label)`, and routes to the matching endpoint registered via
`server.of(label)`.

```javascript
const { RemoteSerialportServer, MqttServer } = require("node-serialport-server");

new RemoteSerialportServer(undefined, 0, {
    transport_server: new MqttServer({
        broker_url: "mqtt://broker.internal:1883",
        topic_prefix: "rsp",            // optional, default "rsp"
        qos: 1,                          // QoS 0 will lose bytes; do not use for serial streams
        mqtt_options: { username: "u", password: "p" }
    }),
    auto_pipe: true
});
```

`MqttServerOptions`:

| Option | Default | What it does |
|---|---|---|
| `broker_url` | (required) | e.g. `mqtt://host:1883` or `mqtts://host:8883`. |
| `topic_prefix` | `"rsp"` | First topic level; must match the client's `topic_prefix`. |
| `server_id` | random UUID | Appears in the MQTT client id; helps broker-side tracing. |
| `qos` | `1` | MQTT QoS for both directions. **Don't set 0** — at-most-once delivery corrupts the serial stream. |
| `mqtt_options` | — | Forwarded to `mqtt.connect`: auth, TLS, keepalive, will, etc. |
| `logger` | default | Inject your `Logger`. |

The walkthrough's [mqtt-smoke.js](../note/walkthrough/mqtt-smoke.js) bundles `aedes` as an
in-process broker so you can try this without installing mosquitto.

**Trade-offs vs. direct transports:**

- Slowest of the built-ins (broker hop per direction): ~4 MB/s, ~11 ms p99 RTT locally
- Decoupled deployment — server and clients don't need to know each other's network address
- Free pub-sub semantics (multiple clients can naturally subscribe to one device)
- Broker can persist messages / retry on flaky links (depends on broker config + QoS)

> **⚠ QoS 1 retransmits and write-critical workloads.** MQTT QoS 1 is "at-least-once":
> under packet loss, the broker may redeliver the same PUBLISH and the receiver acks each
> copy. **This library does NOT deduplicate retransmitted messages at the application
> layer** — if the network drops a PUBACK and the broker resends, a `serialport_send_packet`
> envelope can reach the device's port **twice**, writing the same Modbus PDU / RS-485
> command twice. For write-idempotent workloads (status polling, log streaming) this is
> usually fine. For write-critical workloads (commanding actuators, Modbus function-code
> 5/6/15/16) one of the following is required:
>
> - Set `qos: 2` (exactly-once; broker uses 4-step handshake — higher latency, no
>   duplicates).
> - Use a different transport (Raw TCP / Raw WS / HTTP/2) where the underlying TCP stream
>   gives in-order non-duplicated delivery.
> - Dedup at the app layer by stamping each command with a sequence number.
>
> Also, **MQTT KeepAlive defaults to ~60 s** in the `mqtt` lib: a dead server is not
> detected on the client side until KeepAlive expires. Tune via `mqtt_options.keepalive`
> if you need faster failure detection.

#### gRPC (`GrpcServer`)

Wraps `@grpc/grpc-js`. Wire protocol is a single bi-directional streaming RPC defined in
[`proto/remote-serialport.proto`](proto/remote-serialport.proto). Each `Channel(stream Envelope)`
call is one `AbsTransport` (one namespace). The namespace label rides in stream metadata under
`rsp-label`; the auth credential under `rsp-auth` (JSON-encoded).

Use when you're already running in a gRPC ecosystem (envoy / linkerd / service mesh,
observability via OpenTelemetry, mTLS via `grpc.ServerCredentials.createSsl`) and want this
library to fit in naturally.

```javascript
const { RemoteSerialportServer, GrpcServer } = require("node-serialport-server");
const grpc = require("@grpc/grpc-js");

// Insecure (dev / trusted internal networks)
new RemoteSerialportServer(undefined, 0, {
    transport_server: new GrpcServer({ address: "0.0.0.0:17996" }),
    auto_pipe: true
});

// TLS (server auth)
const tls_creds = grpc.ServerCredentials.createSsl(
    null,  // no client CA = no mTLS
    [{ private_key: fs.readFileSync("server.key"), cert_chain: fs.readFileSync("server.crt") }],
    false  // checkClientCertificate
);
new GrpcServer({ address: "0.0.0.0:17997" }, { credentials: tls_creds });
```

`GrpcServerOptions`:

| Option | Default | What it does |
|---|---|---|
| `credentials` | `grpc.ServerCredentials.createInsecure()` | Standard gRPC credentials. Pass `createSsl(...)` for TLS / mTLS. |
| `logger` | default | Inject your `Logger`. |

The `.proto` file is shipped in this package under `proto/`; the server loads it via
`@grpc/proto-loader` at first listen. Don't rename or delete that file at install time.

**Trade-offs:**

- Slower than direct transports (protobuf wrap + HTTP/2 stream management): ~7 MB/s throughput
- p99 RTT ~15 ms — middle of the pack but worse than raw HTTP/2 because of the per-message wrap
- Native gRPC tooling works: grpcurl, envoy, gRPC reflection, etc.

#### WebRTC DataChannel (`WebRtcServer`) — experimental

True peer-to-peer transport using `node-datachannel` (WebRTC over SCTP-over-DTLS-over-ICE).
**Marked experimental** because `node-datachannel` is still maturing and WebRTC introduces a
hard dependency on an out-of-band signaling channel for SDP + ICE exchange.

```javascript
const { RemoteSerialportServer, WebRtcServer } = require("node-serialport-server");

// You provide a SignalingChannel — anything that can pass SDP offers/answers + ICE
// candidates between server and client. The walkthrough uses an in-process EventEmitter;
// production deployments typically use a small WebSocket signaling server.
const signaling = {
    on_message(handler) { /* hook handler to your channel of choice */ },
    send(msg) { /* push msg to the matching peer */ }
};

new RemoteSerialportServer(undefined, 0, {
    transport_server: new WebRtcServer({
        signaling,
        ice_servers: ["stun:stun.l.google.com:19302"]   // strings only — not W3C objects
    }),
    auto_pipe: true
});
```

`WebRtcServerOptions`:

| Option | Default | What it does |
|---|---|---|
| `signaling` | (required) | A `WebRtcSignalingChannel` that exchanges `{kind: "offer" \| "answer" \| "candidate", peer_id, sdp?, candidate?, mid?}` messages with each remote peer. |
| `ice_servers` | `["stun:stun.l.google.com:19302"]` | Array of strings — `node-datachannel` does NOT accept the W3C `{urls, username, credential}` object form. For TURN: `"turn:user:pass@host:3478"`. |
| `logger` | default | Inject your `Logger`. |

Each `DataChannel(label)` opened by a client maps to one transport on the server side. The
namespace label is the DataChannel label (`dc.getLabel()`).

**Trade-offs:**

- True P2P — once the connection is up, traffic doesn't pass through any server. Great for
  fan-in / fan-out where you want to skip a relay.
- Setup cost: 1-3 seconds for ICE gathering + DTLS handshake in real-world (loopback is much
  faster).
- Bring-your-own signaling server. The library ships a `WebRtcSignalingChannel` interface and
  the walkthrough demo uses in-process EventEmitter. For browsers, the typical setup is a
  WebSocket signaling server with a cross-origin policy.
- `node-datachannel` is a native dependency (libdatachannel + libsrtp + libjuice) — heavier
  install footprint than the JS-only transports.
- WebRTC has no built-in app-layer auth — if you need to gate connections, put your auth in
  the signaling layer (the user controls the signaling channel), or send a `hello` envelope as
  the first message and reject in `auth_validator`.
- **Shared mode** (`multi_access: "shared"`) works on WebRTC just like every other transport:
  multiple peers, each with their own `WebRtcClient` + own signaling channel pair, can attach
  to one `WebRtcServer` against the same physical port. The server demuxes by `peer_id` from
  signaling messages; per-path `SharedSessionRegistry` refcounts them. Your signaling adapter
  must support multiple peer_ids — the walkthrough's [`round10-webrtc-shared.js`](../note/walkthrough/round10-webrtc-shared.js) shows the pattern (one `make_client_channel(peer_id)` per client).

**Real-world deployment notes (TURN / NAT traversal)**

The walkthrough numbers (12.79 MB/s, 0.67 ms p50) are **loopback** — they do NOT reflect
production. Plan for these realities:

- **STUN alone is not enough on most corporate / mobile networks.** Symmetric NAT (common
  on enterprise firewalls, 4G/5G carriers, hotel Wi-Fi) cannot be traversed with STUN. Such
  peers will fail to connect unless you provide a **TURN relay**.
- **TURN reverts WebRTC to a relayed path** — all traffic flows through the TURN server.
  You lose the "true P2P" benefit and pay the TURN server's bandwidth. Throughput and
  latency look more like a TCP relay than direct UDP.
- **ICE gathering takes time.** Loopback: ~ms. Same-LAN: ~100-300 ms. Across the public
  internet with TURN candidates: 1-3 s typical, 5-10 s on slow networks.
- **DTLS handshake** adds another round-trip on top of ICE.
- **Provide both STUN and TURN in `ice_servers`.** Example:

  ```javascript
  ice_servers: [
      "stun:stun.l.google.com:19302",
      "turn:turn-user:turn-pass@turn.example.com:3478",
      "turns:turn-user:turn-pass@turn.example.com:5349",  // TURN over TLS
  ]
  ```

  Run your own [coturn](https://github.com/coturn/coturn) or use a hosted service (Twilio
  NAT Traversal, Cloudflare TURN, Xirsys). Free public STUN servers are fine; do NOT use
  free public TURN — they're rate-limited or not available.
- **The library does NOT diagnose NAT failures for you.** If a peer cannot establish ICE,
  the `WebRtcClient` simply never reaches `state === "open"`. Set a connection timeout in
  your app code and surface "WebRTC connection failed (check NAT/TURN config)" to the user.
- **Signaling is your responsibility** — the library's `WebRtcSignalingChannel` is just the
  protocol shape (offer/answer/candidate). Real deployments use a small WebSocket signaling
  service that routes messages between peers; the walkthrough uses an in-process
  `EventEmitter` only because there's no real network in the test.

For browsers as the peer, see the Node-only banner at the top of this README — the
*signaling* side can be a browser (browsers can speak WebRTC natively), but the *Node side*
of the connection still runs this library.

## Protocol (v2)

`serialport_handshake` (S→C) announces the protocol version on connect; the client checks
compatibility.

| Direction | Namespace mode | Mux mode (payload carries `path`) |
|---|---|---|
| S→C | `serialport_handshake` `{protocolVersion}` | `serialport_handshake` |
| C→S | `serialport_open` `{path, options}` | `serialport_mux_open` `{path, options}` |
| S→C | `serialport_state` `{state, message?}` | `serialport_mux_state` `{path, state, message?}` |
| S→C | `serialport_packet` (raw bytes) | `serialport_mux_packet` `{path, data}` |
| C→S | `serialport_send_packet` (raw bytes) | `serialport_mux_send_packet` `{path, data}` |
| S→C | `serialport_drain` (backpressure ack) | `serialport_mux_drain` `{path}` |
| C→S | `serialport_close` | `serialport_mux_close` `{path}` |
| C→S RPC | `serialport_set` `{options}` / `serialport_update` `{options}` / `serialport_flush` | `serialport_mux_set` / `_update` / `_flush` `{path, …}` |
| C→S RPC (ack) | `serialport_get` → `{cts,dsr,dcd}` · `serialport_list` → `PortInfo[]` | `serialport_mux_get` `{path}` → status · `serialport_list` (shared) |
| C→S Txn | `serialport_send_begin/_chunk/_end/_abort` `{txn_id, …}` | `serialport_mux_send_begin/_chunk/_end/_abort` `{path, txn_id, …}` |

`RemoteSerialPortState`: `idle → opening → open → closing → closed`, plus `error`.

**Backpressure (client → device):** the client uses a write window; each `serialport_send_packet`
(or `serialport_send_end`) consumes a slot and each `serialport_drain` from the server frees one.
When the window fills, `port.write(...)` returns `false` and the stream emits `'drain'` once it
clears.

**Backpressure (device → client):** when `socket.pipe()` is forwarding, the server samples the
underlying transport's buffered byte count after each emit and `pause()`s the physical port if it
crosses 1 MB; resumes once below 256 KB. Only in `multi_access: 'reject'` mode (see above).

## Features

- [x] Transport abstraction (`AbsTransport`) — swap socket.io for IPC or future transports
  - [x] WebSocket transport (socket.io)
    - [x] Namespace mode (one namespace per remote port)
    - [x] Mux mode (many remote ports per connection, dynamic addressing)
  - [x] Node IPC transport (worker_threads / Electron utility process; mux-only)
- [x] Read from serial port (device → client)
- [x] Write to serial port (client → device)
- [x] Port lifecycle state machine + `serialport_state`
- [x] Backpressure both directions (write window + device pause/resume)
- [x] Injectable physical-port factory (testable without hardware)
- [x] Remote port control RPCs (`set` / `get` / `update` / `flush`) and `list_ports`
- [x] Multiple-server registry (`RemoteSerialportServerManager`)
- [x] Remote `error` / `close` re-emitted on the local virtual stream
- [x] Multi-chunk atomic transactions (`txn()` / `with_txn()`) with timeout
- [x] Injectable `Logger` interface (pino / winston / etc.)
- [x] Auto-reconnect: client replays opens + in-flight RPCs after transport drop (socket.io only)
- [x] Multi-client access policy (`multi_access: 'shared'` with `fifo` / `fifo-strict` / `batch` / `pipe` scheduling)
- [x] **COW shared modes** (`cow-write-isolate` / `cow-snapshot` / `cow-virtual-port`)
- [x] **Authentication** (`auth_validator`, pluggable; works on socket.io `Manager({auth})` + IPC `hello` envelope)
- [x] **ACL hooks** (`acl.can_open` / `can_write` / `can_read`)
- [x] **Identity propagation** (`socket.identity` exposed to app code in the `connection` handler)
- [ ] Encryption: delegated to transport (TLS for socket.io, OS sandbox for IPC); no in-protocol encryption

## Known limitations

- **Per-port `MockBinding` cleanup** (test mode only): `@serialport/binding-mock`'s registry
  (`MockBinding.serialPorts`) has no `removePort()` API. `port_instance.close()` releases the lock
  and stream, but the path entry persists in the process-wide registry until `MockBinding.reset()`
  (which `rsc.disconnect()` with no argument calls). In long-running test processes that create
  many ports under different paths, expect the registry to grow until a full `disconnect()`.
- **Per-txn success/failure ack**: client `tx.end()` resolves on the `serialport_drain` ack. If the
  server times out the txn before `_end` arrives, the eventual `_end` still gets an "unknown txn"
  ack from the server, so `tx.end()` resolves silently as success even though the bytes never
  reached the device. The server's logger (and `txn_timeout_action: 'state'`/`'both'`) is the way
  to detect this server-side.
- **IPC transport is single-endpoint**: one `MessagePort` pair represents one client connection,
  so `server.of(label)` / `server.mux(label)` both return endpoints backed by the same single
  transport regardless of label. To host many remote ports over one IPC pair, use **mux mode**
  (`server.mux()` + `client.mux()`). Multi-endpoint IPC demux (envelope-level `ns` routing) is
  not implemented in P4.

## Production monitoring

This library's leak / cleanup paths are covered by R4 cleanup-probe (20 scenarios × 4
byte-stream transports) and R7 soak (400 cycles × 4 byte-stream transports — heap grew
&lt;1 MB, internal Maps peaked at 1 and returned to 0). What was NOT exercised in CI: a
**continuous multi-hour soak** with sustained traffic. Recommended monitoring for any
24/7 server deployment:

- **RSS / heap growth** — `process.memoryUsage().rss` and `.heapUsed` sampled periodically.
  Any monotonic growth over hours is a flag; restart policy + ops dashboard.
- **File descriptor count** (`lsof -p $PID | wc -l` on Linux, or `Get-Process` handles on
  Windows). The library cleans connections (D7 / D8 / M7) but the underlying socket
  library may not release FDs immediately under high churn.
- **Per-process listener accumulation** — turn on
  `process.env.NODE_NO_WARNINGS=` empty and watch for `MaxListenersExceededWarning` in
  stderr.
- **`unhandled rejection`** + **`uncaught exception`** — install `process.on(...)` handlers
  and log; the library wraps listener invocations in try/catch but external app code may not.
- For MQTT-based deployments, **broker-side metrics** matter more than process-side: queue
  depth, in-flight count, KeepAlive failures.

Recommended pre-release: run your application against this library for at least 24 hours
of representative traffic before declaring a deployment stable. None of the existing
CI-friendly tests are long-duration; that's a release-engineering job.

<a id="中文"></a>

## 中文

> **⚠ Node.js 限定。** 這個 library 用了 Node 的 `Buffer`、`worker_threads`、`node:http2`、native `serialport` binding 等 Node 專屬 API。**瀏覽器跑不起來** — 用 webpack / Vite / Rollup 打包會在 `Buffer`/`stream`/`net` import 直接炸。雖然 socket.io 跟 `ws` 自己有 browser build，但這個 library 是 Node↔Node 部署裡的 *Node 端*。要做瀏覽器前端，請自己寫一層薄薄的 app-layer adapter（搭配你自己的 WebSocket / WebRTC）把 bytes 轉過去 — 不要試圖直接 bundle 這個 package 進 browser。

把主機的實體序列埠透過網路代理出去：**server** 守住真實的序列埠；**client** 連上來，拿到一個本地 *虛擬* 序列埠（用 mock-binding 撐起來的 `SerialPortStream`）對應某個遠端埠。對虛擬埠的讀寫會轉發到實體埠，反之亦然 — 既有的 Node serialport 生態（`serialport`、`modbus-serial` …）幾乎零修改就能跨網路使用。

專案拆三個 package：

| Package | npm | 角色 |
|---|---|---|
| [`remote-serialport-types`](https://github.com/teddy1565/remote-serialport-types) | `remote-serialport-types` | 共用型別 + abstract 介面（被另兩個 repo 以 git submodule 內嵌引用）。 |
| [`remote-serialport-server`](https://github.com/teddy1565/remote-serialport-server) | `node-serialport-server` | 守實體序列埠；透過 socket.io 對外。 |
| [`remote-serialport-client`](https://github.com/teddy1565/remote-serialport-client) | `node-serialport-client` | 連 server；把遠端埠暴露成本地虛擬埠。 |

> **從原始碼開發？** `types` package 以 submodule 內嵌在 `src/types/remote-serialport-types`。`git submodule update --init` 後**也要進那個目錄跑一次 `npm install`**（它有自己的依賴），`tsc` 才能解析所有型別。

### 兩種模式

- **Namespace mode** — 一個 socket.io namespace = 一個遠端序列埠。`client.connect("/dev/ttyUSB0", …)`。simple、socket.io 慣用；多個 `connect()` 共用同一條傳輸通道（socket.io namespace 多工），所以單一連線仍可承載多埠。
- **Mux mode** — 一條 mux namespace 上的連線可承載任意多個遠端埠，由訊息 payload 內的 `path` 動態定址。給「不想 namespace 一對一」的場景（IoT mesh、動態定址）。`client.mux("/site-A").open("/dev/ttyUSB0", …)`。

兩種模式 wire format 結構相同；差別只是「socket 本身就是 routing key（namespace mode，payload 是裸 bytes）」還是「每個 payload 帶 `path`（mux mode）」。

### 安裝

```bash
npm install node-serialport-server   # server
npm install node-serialport-client   # client
```

### Server

#### Namespace mode（中文範例對應英文段同樣的 code，請看 [Server § Namespace mode](#server)）

`RemoteSerialServerOptions` 重點：

| 選項 | 預設 | 說明 |
|---|---|---|
| `serialport_namespace_regexp` | `/^(\/dev\/tty(USB\|AMA\|ACM)\|\/COM)[0-9]+$/` | 接受的 namespace 必須 match 這條 regex 才會被當 serial-port path。要用自訂 path（例如 `/dev/ttyMODBUS`、`/dev/ttyUSB100` 帶非純數字 suffix）就要覆寫。 |
| `strict_path` | `true` | `false` 時 namespace 純當 routing label，真實 path 從 client 的 `options.path` 來（仍走 regex 驗證）。 |
| `auto_pipe` | `false` | `true` 則每條接受的連線自動 `pipe()` 讀方向。純 relay 場景建議直接開 `true`，`connection` handler body 可以空白 — 但 `server.of(...).on("connection", ...)` 這行**還是必須寫**（沒寫的話 socket.io namespace 的 `connection` handler 不會被掛上，整個 server 會靜默吃掉所有 client，library 會在 `listen()` 後 1.5 秒發 `warn`）。 |
| `serialport_factory` | `(opts) => new SerialPort(opts)` | 測試時注入 mock factory。 |
| `port_list_provider` | `() => SerialPort.list()` | 覆寫 `serialport_list` RPC 回傳。**測試時跟 `serialport_factory` 是一對**：真實的 `SerialPort.list()` 看不到 `SerialPortMock`，所以 mock factory 通常要配 mock list。 |
| `logger` | warn/error → console、debug/info 靜默 | 注入 pino / winston / 自寫 `Logger`。 |
| `multi_access` | `'reject'` | `'shared'` 讓多 client 共用同一條 path（refcount）。 |
| `shared_mode` | `'fifo'` | 僅 `multi_access='shared'` 時有效；7 種詳見下方共享模式表。 |
| `cow_snapshot_buffer_bytes` | `65536` | `shared_mode='cow-snapshot'` 的 ring buffer 大小。 |
| `txn_timeout_ms` | `5000` | 每筆 txn 的 timeout；每 `_chunk` reset；超時 drop 已 buffer 的 chunks。 |
| `txn_timeout_action` | `'log'` | `'log'` / `'state'`（也發 `serialport_state: ERROR`）/ `'both'`。 |
| `auth_validator` | — | 認證 validator；參見「認證與 ACL」。 |
| `acl` | — | 三組 hook：`can_open` / `can_write` / `can_read`。 |
| `transport_server` | `new SocketIoServer(...)` | 注入自訂 transport（例如 `NodeIpcServer`）。 |

#### Mux mode

`server.mux().on("connection", socket => socket.pipe())` — 一條連線接所有遠端埠；用 `socket.port(path)` 拿到對應的 port proxy。

`server.mux("/site-A")`（或 regex）可指定 mux namespace；預設 `/`。

### Client

#### Namespace mode — 自動 open

`new RemoteSerialportClient(host, options).connect(namespace, open_options)` 一行接上就 ready。連線完成（handshake 後）自動 send `serialport_open`。範例 code 請看 [Client](#client) 英文段。

#### Namespace mode — 手動 open

不傳 `open_options`：先 `connect(namespace)` 拿 socket，之後再 `socket.open(open_options)`。

#### 與 `modbus-serial` 整合

`create_port(local_path)` 後 `get_port({ baudRate, autoOpen: true })` 拿到的 stream 結構上是個正常 `SerialPortStream`。其它套件（如 `modbus-serial`）直接吃這個 stream 不用改 code。

#### Mux mode

`rsc.mux().open(remote_path, options)` → `rsc.mux().create_port(remote_path, local_path)` 拿到本地虛擬埠。

#### Remote port 控制 / 探索（RPC）

- `set_remote(SetOptions)`、`update_remote(UpdateOptions)`、`flush_remote()` — fire-and-forget
- `get_remote_status()` → `Promise<PortStatus>`、`list_ports()` → `Promise<PortInfo[]>` — 走 socket.io ack 包成 Promise

#### Multi-server registry

`RemoteSerialportServerManager` 把多個 server 用 key 註冊起來方便管。

#### Disconnect

`rsc.disconnect(namespace)` 斷單條；`rsc.disconnect()` 全斷並 reset MockBinding registry。

### 多 chunk transactions（txn）

```javascript
const tx = portInstance.txn();
tx.write(Buffer.from("HEAD_"));
tx.write(Buffer.from("BODY_"));
tx.write(Buffer.from("TAIL"));
await tx.end();   // 在 server 端被當成 ONE atomic write 到 device
// 或：tx.abort() — server drop 全部 buffered chunks
```

便利包裝 `portInstance.with_txn(async (handle) => { … })`：自動 `end()`，throw 時自動 `abort()`。

語意：
- `_begin` → 0..N 個 `_chunk` → `_end`（送 device）或 `_abort`（drop）
- 只有 `_end` 跟單發 `serialport_send_packet` 消耗背壓窗口
- Server-side timeout（每 chunk reset）：drop buffered chunks（行為由 `txn_timeout_action` 決定）

### Logger

```typescript
interface Logger {
    debug(message: string, ...meta: unknown[]): void;
    info(message: string, ...meta: unknown[]): void;
    warn(message: string, ...meta: unknown[]): void;
    error(message: string, ...meta: unknown[]): void;
}
```

預設：warn/error → `console`，debug/info 靜默。可注入 pino / winston / bunyan，或寫個 prefix wrapper。

### Reconnect 行為（client，僅 socket.io transport）

- Transport 斷線：socket.io 自動重連（指數退避）
- 重連完成、handshake 後：client 重發所有 `_active_opens` 的 `serialport_mux_open` / 重新自動 `serialport_open`
- In-flight RPC：option `rpc.replay_on_reconnect`（預設 `true`）— `connect` 事件 fire 時把 `_pending_rpcs` 全部用同一個 ack callback 重發；timeout 是從第一次呼叫起算的 wall-clock（不重置）。若 `false` → `disconnect` 事件當下直接 reject 全部 pending
- IPC transport：無 reconnect。`on_lifecycle("reconnect")` 永不 fire

### Shared mode（`multi_access: 'shared'`）

多個 client 連到同一條 path；server refcount 共用一個 `SharedPortSession`。namespace mode + mux mode 都支援；同 path 的 ns + mux client 共用同一個底層 session。

7 種 `shared_mode`：

| `shared_mode` | 寫排程 | 讀 |
|---|---|---|
| `'fifo'` (預設) | 以 `_begin` 抵達順序嚴格排，HOL（B 的 `_end` 早到不會插到 A 之前） | 全 fanout |
| `'fifo-strict'` | 同 `'fifo'` + server 一次只允許一筆 in-flight write | 全 fanout |
| `'batch'` | `_end` / 單發抵達即 flush — wire 上是 `_end`-order，無 HOL | 全 fanout |
| `'pipe'` | 第一連的當 writer，其它 read-only（writes 丟棄但 drain 仍 ack）；writer 斷 → 下一個最早 live subscriber 自動升級 | 全 fanout |
| `'cow-write-isolate'` | 立即 flush + 每 subscriber 記下最近寫入；device echo prefix-match 該 subscriber → 只回給 writer | echo-filter fanout（match 的只給 writer；剩下 fanout） |
| `'cow-snapshot'` | 立即 flush | fanout + 新 subscriber 加入時先 replay `cow_snapshot_buffer_bytes` 大小的 ring buffer（預設 64 KB） |
| `'cow-virtual-port'` | 立即 flush + 每 subscriber 的 `set`/`update` state 各自 cache（物理 last-wins，library 記 `warn` log conflict） | 全 fanout |

排程與 writer policy 都是 **per-path**。每筆 write 的 drain ack 只路由給該 subscriber，不會跨 client 卡背壓窗口。

**`cow-write-isolate` 注意事項**：echo filter 是 byte-level prefix match。device 在 echo 前改 byte（加 `\r\n`、轉碼…）會打敗 filter — 那些 unmatched bytes 落回全 fanout，全部 subscriber 看得到。適合 line-echo 或 full-duplex 原樣 echo 的 device；不要用它做真正的 byte-level 隔離。

**Shared 模式下 hook `socket.port` 的陷阱**：`connection` handler 拿到的 `socket.port` 是**共享**的物理埠 `EventEmitter`，不是 per-subscriber 的視圖。所以 `socket.port.on("data", …)` / `socket.port.on("write-command", …)` 會**每個 subscriber 各裝一個 listener，每筆事件依 listener 數量觸發**；listener closure 抓到的 `socket.identity` 是當下裝 listener 的那個 socket，不是寫的 client。

```javascript
// WRONG — N 個 subscriber 就裝 N 個 listener，且 id.user tag 錯誤對應
server.of().on("connection", (socket) => {
  const id = socket.identity;
  socket.port.on("write-command", (chunk) => log(`${id.user} wrote ${chunk}`));
});

// Right — 只裝一次，把 chunk 當匿名處理
let installed = false;
server.of().on("connection", (socket) => {
  if (installed) return; installed = true;
  socket.port.on("write-command", (chunk) => log(`someone wrote ${chunk}`));
});
```

要 per-write attribution 請走 `acl.can_write`（per-subscriber 帶 `identity`）並在那邊紀錄。Listener 加 `subscriber_id` 參數是未來 minor version 可能加的 API。

**Shared 模式用 `SerialPortMock` 測試的注意事項**：最後一個 subscriber 離開時 `SharedPortSession` 會把底層物理埠關掉。如果測試 harness 透過 `serialport_factory` 抓住 mock 來推 synthetic device output，那個 captured 變數現在指向已關閉的 mock，`emitData(...)` 會丟 `Port must be open to pretend to receive data`。下一個 subscriber 來時 factory 會給一個**全新**的 mock — 所以不要只 capture 一次，每次 factory 被呼叫都要重 capture，並用 `mock.isOpen` 加 try/catch 守 `emitData`：

```javascript
let captured = null;
new RemoteSerialportServer({}, 0, {
  multi_access: "shared", shared_mode: "fifo",
  serialport_factory: (opts) => { const m = new SerialPortMock(opts); captured = m; return m; }
});
setInterval(() => {
  if (captured === null || captured.isOpen === false) return;
  try { captured.port.emitData(buf); } catch { /* port flipped to closed between check + emit */ }
}, 400);
```

### 認證與 ACL（`auth_validator` + `acl`）

```javascript
const server = new RemoteSerialportServer({ cors: { origin: "*" } }, 17991, {
  auth_validator: async (credential, meta) => {
    // credential 就是 client 放在 `auth` 欄位的東西（JWT / API key / 任何 app 自訂格式）
    // meta = { transport_id, endpoint_label }
    const user = await my_verify(credential);
    if (user === null) return { ok: false, message: "bad token" };
    return { ok: true, identity: user };  // attach 到 socket.identity，後續 ACL 用
  },
  acl: {
    can_open: (identity, path) => identity.role === "admin" || allowed_paths(identity).includes(path),
    can_write: (identity, path) => identity.role !== "viewer",
    can_read:  (identity, path) => true
  }
});
```

`auth_validator` 每條接受的 transport 跑一次（socket.io 重連時會再跑，因為 `Manager({auth})` 自動 replay）。拒絕：發 `serialport_state: ERROR { message }` 再 close transport — user 的 `connection` handler **永遠不會 fire** 這個 socket。

`acl` 三個 hook **per-operation** 決定：

| Hook | 觸發 | 拒絕效果 |
|---|---|---|
| `can_open(identity, path)` | `serialport_open` / `serialport_mux_open` | `serialport_state: ERROR { message: "open denied: ..." }`；port 停在 IDLE |
| `can_write(identity, path)` | 所有寫方向訊息：`_send_packet` / `_send_begin` / `_send_end` / `_set` / `_update` / `_flush` | `serialport_state: ERROR { message: "write denied: ..." }` + `serialport_drain`（讓 client 的背壓窗口繼續流動），bytes 在送達 device 前丟棄 |
| `can_read(identity, path)` | `open` 後一次 | 一次性 `serialport_state: ERROR { message: "read denied: ..." }` + 後續 device→client packets 對該 client 靜默過濾 |

Client 透過本地虛擬 stream 的 `'error'` 事件就能拿到 ERROR state — 既有的 serialport code 不用改就能反應 deny。

#### 加密 / TLS

Library 本身不包 TLS。各 transport 的 TLS 設定：

- **socket.io**：自己起 `https.Server`，再把 library 內部的 socket.io 用公開的 `srv.io` accessor 接上去 — 接完**不要**呼叫 `srv.listen()`（會多開一個明文 listener）：

  ```javascript
  const httpsServer = require("https").createServer({ key, cert });
  const srv = new RemoteSerialportServer({ cors: { origin: "*" } }, 17991, { /* ... */ });
  srv.io.attach(httpsServer);                       // socket.io 接到 https
  srv.of("/dev/ttyUSB0").on("connection", () => {});  // friction#9 還是要 register
  httpsServer.listen(17991);                        // https 自己 listen
  // (這個模式下不要再 srv.listen())
  ```
- **Raw TCP / Raw WebSocket / HTTP/2**：transport ctor 內建 `{ tls: ... }` option。
- **gRPC**：內建 `credentials` option，傳 `grpc.ServerCredentials.createSsl(...)`。
- **MQTT**：用 `mqtts://` broker URL；`mqtt_options` 可以丟任何 `mqtt` lib 支援的 TLS 選項。
- **WebRTC**：規範本身就是 SCTP-over-DTLS-over-ICE，沒有 app 層憑證設定。
- **IPC**：靠 OS-level sandbox / process isolation。

socket.io 的 mTLS：把 `{requestCert: true, ca, ...}` 傳給 `https.createServer(...)`。

### Wire backpressure（device→client）

`socket.pipe()` forward 物理 bytes 比 client drain 還快時，server 每次 emit 後採樣底層 socket.io transport 的 `bufferedAmount`；超過 `WIRE_BACKPRESSURE_HIGH_WATER`（1 MB）就 `pause()` 物理埠；定期檢查（`WIRE_BACKPRESSURE_POLL_MS`，50 ms）— 一旦掉到 `WIRE_BACKPRESSURE_LOW_WATER`（256 KB）以下就 `resume()`。只在 `multi_access: 'reject'` 模式下生效 — shared 模式 pause/resume 會餓死其它 subscriber 所以停用。IPC transport 的 `get_buffered_amount()` 回 `null`，wire backpressure 自動跳過。

### Transports（`AbsTransport`）

Wire protocol 跟 transport 無關。預設用 **socket.io**（TCP/WebSocket）；另一個內建 transport 是 **Node IPC**（`worker_threads.MessagePort` / Electron utility process `MessagePortMain`）。透過 ctor option `transport_server` 注入切換 — 詳見 [Transports](#transports-abstransport) 英文段範例。

> **IPC 的 `label` 就是 serial port path**：`new NodeIpcServer(port, label)` 第二參數是 `endpoint_label`，會直接變成這條 IPC pair 上 socket 的隱式 `serialport_path`。namespace 模式下要傳真實裝置路徑（`"/dev/ttyUSB0"`、`"COM3"`），**不是除錯用名稱**。（`server.of(label)` 對 IPC server 而言 *不用* label 路由 — IPC pair 只有一條連線 — 所以 constructor 的 `label` 是路徑的唯一來源。）mux 模式下 label 不參與路由，傳什麼都可以（路徑從各 `open()` payload 取）。

IPC transport 跟 socket.io 的差異：

| 行為 | socket.io | Node IPC |
|---|---|---|
| Reconnect | 自動重連、client RPC replay | 不重連 — port pair 是 single-shot |
| Wire backpressure | 採樣 `bufferedAmount` | `get_buffered_amount()` 回 `null`，跳過 |
| Endpoint 多工 | 每 `of(label)` 一個 namespace | 單 endpoint per IPC pair；**用 mux mode** 接多埠 |
| Connection model | 多 client → server | 1-to-1 process pair |

何時用 IPC：兩端都在同一個 Node process tree（worker threads、Electron utility process）。要跨 host / 跨網路就用 socket.io。

#### Raw TCP / Unix Domain Socket / Named Pipe（`RawTcpServer`）

長度前綴 framing + JSON envelope，跑在 `net.Socket` 上。適合：依賴最小化、封閉 LAN 不需要 socket.io 的 HTTP polling fallback、或想透過 OS 級的 pipe（UDS / Named Pipe）而不是 TCP。

```javascript
const { RemoteSerialportServer, RawTcpServer } = require("node-serialport-server");

// Plain TCP，mux 模式（預設）
new RemoteSerialportServer(undefined, 0, {
    transport_server: new RawTcpServer({ port: 17993 }),
    auto_pipe: true
});

// TLS over TCP
new RawTcpServer({ port: 17994 }, { tls: { key, cert } });

// 1-to-1（一條連線一個 namespace，IPC-like）
new RawTcpServer({ port: 17995 }, { mode: "single-namespace" });

// UDS（Linux/Mac）/ Named Pipe（Windows）— `path` 取代 `port`
new RawTcpServer({ path: "/tmp/rsp.sock" });
new RawTcpServer({ path: "\\\\.\\pipe\\rsp" });
```

`RawTcpServerOptions`：

| 選項 | 預設 | 說明 |
|---|---|---|
| `mode` | `"mux"` | `"mux"`：一條 TCP 連線多工承載多個 namespace（envelope `ns` 欄位區分，socket.io-like）。`"single-namespace"`：一條 TCP 連線 = 一個 namespace，hello 時鎖死（IPC-like）。 |
| `tls` | — | `tls.TlsOptions`。要開 TLS 就傳；plain TCP 就不傳。`path:` target（UDS / Named Pipe）會被忽略 — UDS/Pipe 沒 TLS 概念，安全邊界是檔案 permission。 |
| `keep_alive` | `true` (30 秒) | TCP keepalive。`false` 關掉；`{ initial_delay_ms }` 自訂初始延遲。 |
| `permissions` | — | UDS path `listen()` 後 chmod（例如 `0o660`）。TCP / Pipe 無效。 |
| `logger` | 預設 | 注入自訂 `Logger`。 |

**Wire format**（每 frame）：`[4 bytes BE total len][4 bytes BE json len][JSON envelope][optional binary tail]`。Hot channel（`serialport_packet`、mux/txn data）的 Buffer 走 binary tail，直接傳原始 bytes 不 JSON-encode — 避開 4 KB → 20 KB 的膨脹，throughput 因此能上 ~12 MB/s（不然 ~1 MB/s）。

**Throughput / latency（localhost、4 KB device-emit chunks）**：

| | Throughput | RTT p50 / p99 |
|---|---|---|
| Raw WebSocket（mux、plain） | 44.16 MB/s | 0.46 / 2.33 ms |
| socket.io | 18.18 MB/s | 0.66 / 1.67 ms |
| HTTP/2（h2c） | 16.92 MB/s | 0.48 / **1.48 ms** |
| WebRTC DataChannel（loopback、無 NAT） | 12.79 MB/s | 0.67 / 3.35 ms |
| Raw TCP（mux、plain） | 11.72 MB/s | **0.40** / 3.71 ms |
| gRPC（insecure） | 6.80 MB/s | 1.34 / 14.87 ms |
| Node IPC（worker_threads） | 4.70 MB/s | n/a（單 process） |
| MQTT（aedes broker localhost） | 4.24 MB/s | 2.62 / 11.99 ms |

`ws` 的 binary framing 比 Engine.IO 更精簡；socket.io 在整體穩定度上較強（多層緩衝）；HTTP/2 在 **p99 最好**（每個 stream 各自 flow control → 沒 HOL blocking）；Raw TCP 在 p50 上贏在 stack 薄。WebRTC localhost 數字不反映真實部署 — production 要加上 NAT / ICE / TURN 成本。gRPC 每個 message 多一層 protobuf 包，throughput 中等、p99 受 framing 拖累。MQTT 每方向多一個 broker 跳，是最慢的 — 但換來 pub-sub 語意跟 broker 持久化的便利。

#### Raw WebSocket（`RawWebSocketServer`）

跟 Raw TCP 同一套 envelope + framing，但跑在 `ws` 函式庫的 WebSocket 協定上。適合：想用 TCP-only 不需要 HTTP polling fallback 的 socket.io 替代品、需要 browser client、要把 WebSocket 掛到既有 HTTP server 上共用 port。

```javascript
const { RemoteSerialportServer, RawWebSocketServer } = require("node-serialport-server");

// Plain ws://，mux 模式（預設）
new RemoteSerialportServer(undefined, 0, {
    transport_server: new RawWebSocketServer({ port: 17996 }),
    auto_pipe: true
});

// TLS（wss://）
new RawWebSocketServer({ port: 17997 }, { tls: { key, cert } });

// 1-to-1
new RawWebSocketServer({ port: 17998 }, { mode: "single-namespace" });

// 自訂 HTTP path（預設 "/"）
new RawWebSocketServer({ port: 17999, path: "/rsp" });
```

`RawWebSocketServerOptions`：

| 選項 | 預設 | 說明 |
|---|---|---|
| `mode` | `"mux"` | 跟 Raw TCP 同義：`"mux"` 一條 ws 共享多 namespace、`"single-namespace"` 一條 ws = 一個 namespace。 |
| `tls` | — | `tls.TlsOptions`。傳了就會把底層 HTTP server 升級成 HTTPS、URL 變 `wss://`。 |
| `logger` | 預設 | 注入自訂 `Logger`。 |

對應 client 是 `RawWebSocketClient`（看 [client README](../remote-serialport-client/README.md#raw-websocket-rawwebsocketclient)）。

#### HTTP/2（`Http2Server`）

用 Node 內建 `node:http2`。每個 namespace = 一條 HTTP/2 session 內的 stream，HTTP/2 原生 stream 多工就是 mux model — 沒有 `mode` 選項。每條 stream 各自有 flow-control window，慢消費者卡在一個 namespace 不會 head-of-line block 其它 namespace（所有內建 transport 裡 p99 最好）。

```javascript
const { RemoteSerialportServer, Http2Server } = require("node-serialport-server");

// h2 over TLS（建議；ALPN "h2"）
new RemoteSerialportServer(undefined, 0, {
    transport_server: new Http2Server({ port: 17996 }, { tls: { key, cert } }),
    auto_pipe: true
});

// h2c cleartext（信任的內網才用 — 多數非 Node 客戶端不支援 h2c）
new Http2Server({ port: 17997 });
```

`Http2ServerOptions`：

| 選項 | 預設 | 說明 |
|---|---|---|
| `tls` | — | `http2.SecureServerOptions`。傳了就 h2 over TLS、`allowHTTP1: false`。沒傳就 h2c cleartext。 |
| `logger` | 預設 | 注入自訂 `Logger`。 |

每條 incoming stream 的 `:path` header 就是 namespace label。所以 `server.of("/dev/ttyUSB0").on("connection", ...)` 對應 client 用 `:path: /dev/ttyUSB0` 開的 stream。Client class（`Http2Client`）會自動把 `open(label)` 的 `label` 設成 `:path`。

#### MQTT broker pattern（`MqttServer`）

連到外部 MQTT broker（mosquitto / EMQX / HiveMQ / aedes / NATS-MQTT 等），broker 變成 wire。Topic 慣例（預設 prefix `"rsp"`）：

```text
<prefix>/c2s/<client_id>/<label>     client → server（含 `hello` envelope）
<prefix>/s2c/<client_id>/<label>     server → client
```

Server 訂閱 `<prefix>/c2s/+/#`（多階 wildcard 接得到含 `/` 的 label），用 `(client_id, label)` demux，路由到 `server.of(label)` 註冊的 endpoint。

```javascript
const { RemoteSerialportServer, MqttServer } = require("node-serialport-server");

new RemoteSerialportServer(undefined, 0, {
    transport_server: new MqttServer({
        broker_url: "mqtt://broker.internal:1883",
        topic_prefix: "rsp",            // 預設 "rsp"
        qos: 1,                          // QoS 0 會掉 byte，serial stream 千萬別設
        mqtt_options: { username: "u", password: "p" }
    }),
    auto_pipe: true
});
```

`MqttServerOptions`：

| 選項 | 預設 | 說明 |
|---|---|---|
| `broker_url` | （必填） | 例如 `mqtt://host:1883` 或 `mqtts://host:8883`。 |
| `topic_prefix` | `"rsp"` | 第一階 topic level；必須跟 client 一致。 |
| `server_id` | 隨機 UUID | 進 MQTT clientId，方便 broker 端 trace。 |
| `qos` | `1` | 雙向 QoS。**不要設 0** — at-most-once 會丟 byte。 |
| `mqtt_options` | — | 直接給 `mqtt.connect`：auth / TLS / keepalive / will / 等。 |
| `logger` | 預設 | 注入自訂 `Logger`。 |

走 walkthrough 試請看 [mqtt-smoke.js](../note/walkthrough/mqtt-smoke.js)，內建 `aedes` in-process broker，不用裝 mosquitto。

**跟直連 transport 的 trade-off：**

- 是內建 transport 裡最慢的（每方向多一個 broker hop）：localhost 約 4 MB/s、p99 RTT 約 11 ms
- 部署解耦 — server 跟 client 不用知道對方的網路位址
- 天然 pub-sub 語意（多個 client 可以自然訂閱同一個 device）
- broker 可持久化訊息 / flaky link retry（看 broker 設定 + QoS）

> **⚠ QoS 1 重送跟「寫關鍵」工作負載**：MQTT QoS 1 是「至少送達一次」。掉包時 broker 會重送 PUBLISH，receiver 對每份都回 PUBACK。**這個 library 不會在 application layer 對重送訊息做去重** — 如果 PUBACK 路上掉了 broker 重送，一個 `serialport_send_packet` envelope 可能會抵達裝置埠**兩次**，把同一個 Modbus PDU / RS-485 command 寫兩次。對寫入冪等的工作（狀態輪詢、log streaming）沒差；對**寫關鍵**（操作 actuator、Modbus function-code 5/6/15/16）需要：
>
> - 設 `qos: 2`（剛好一次；broker 走 4-step handshake — latency 更高但不會重複）。
> - 換不同 transport（Raw TCP / Raw WS / HTTP/2），底層 TCP stream 自帶 in-order 不重複交付。
> - 在 app 層自己用 sequence number 戳每筆命令做去重。
>
> 另外，`mqtt` lib 的 **KeepAlive 預設 ~60 秒**：server 真的掛了 client 端要 ~60 秒後才偵測到。透過 `mqtt_options.keepalive` 調短可加快故障偵測。

#### gRPC（`GrpcServer`）

包 `@grpc/grpc-js`。Wire protocol 是一條 bi-directional streaming RPC，定義在 [`proto/remote-serialport.proto`](proto/remote-serialport.proto)。每個 `Channel(stream Envelope)` 呼叫 = 一條 `AbsTransport`（一個 namespace）。Namespace label 走 stream metadata 的 `rsp-label`、auth credential 走 `rsp-auth`（JSON-encoded）。

什麼時候用：已經在 gRPC 生態圈裡（envoy / linkerd / service mesh、OpenTelemetry observability、`grpc.ServerCredentials.createSsl` 的 mTLS），想讓這個 library 直接融入。

```javascript
const { RemoteSerialportServer, GrpcServer } = require("node-serialport-server");
const grpc = require("@grpc/grpc-js");

// Insecure（dev / 信任內網）
new RemoteSerialportServer(undefined, 0, {
    transport_server: new GrpcServer({ address: "0.0.0.0:17996" }),
    auto_pipe: true
});

// TLS（server auth）
const tls_creds = grpc.ServerCredentials.createSsl(
    null,
    [{ private_key: fs.readFileSync("server.key"), cert_chain: fs.readFileSync("server.crt") }],
    false
);
new GrpcServer({ address: "0.0.0.0:17997" }, { credentials: tls_creds });
```

`GrpcServerOptions`：

| 選項 | 預設 | 說明 |
|---|---|---|
| `credentials` | `grpc.ServerCredentials.createInsecure()` | 標準 gRPC credentials；要 TLS / mTLS 就傳 `createSsl(...)`。 |
| `logger` | 預設 | 注入自訂 `Logger`。 |

`.proto` 檔在 package 的 `proto/` 下，server 第一次 listen 時透過 `@grpc/proto-loader` 載入。安裝後不要改名或刪除這個檔案。

**Trade-offs：**

- 比直連 transport 慢（多 protobuf wrap + HTTP/2 stream 管理）：throughput ~7 MB/s
- p99 RTT ~15 ms — 中段班、比 raw HTTP/2 差（每 message wrap 的成本）
- 換來原生 gRPC 工具鏈：grpcurl、envoy、gRPC reflection 等

#### WebRTC DataChannel（`WebRtcServer`）— experimental

真 P2P transport，用 `node-datachannel`（WebRTC over SCTP-over-DTLS-over-ICE）。**標 experimental**，因為 `node-datachannel` 還在成熟、且 WebRTC 強制依賴 out-of-band signaling 來交換 SDP + ICE 候選。

```javascript
const { RemoteSerialportServer, WebRtcServer } = require("node-serialport-server");

// signaling channel 自己準備 — 任何能把 SDP offer/answer + ICE candidate 在 server / client
// 間傳遞的東西都行。walkthrough 用 in-process EventEmitter；production 通常會起一個小的
// WebSocket signaling server。
const signaling = {
    on_message(handler) { /* hook 到你選的 channel */ },
    send(msg) { /* push msg 到對應的 peer */ }
};

new RemoteSerialportServer(undefined, 0, {
    transport_server: new WebRtcServer({
        signaling,
        ice_servers: ["stun:stun.l.google.com:19302"]   // 純字串 — 不是 W3C 的 object 格式
    }),
    auto_pipe: true
});
```

`WebRtcServerOptions`：

| 選項 | 預設 | 說明 |
|---|---|---|
| `signaling` | （必填） | 一個 `WebRtcSignalingChannel`，負責交換 `{kind: "offer" \| "answer" \| "candidate", peer_id, sdp?, candidate?, mid?}` 訊息。 |
| `ice_servers` | `["stun:stun.l.google.com:19302"]` | 字串陣列 — `node-datachannel` **不接受** W3C 的 `{urls, username, credential}` object 格式。TURN：`"turn:user:pass@host:3478"`。 |
| `logger` | 預設 | 注入自訂 `Logger`。 |

Client 開的每個 `DataChannel(label)` 對應一條 server 端 transport。namespace label 就是 DataChannel label（`dc.getLabel()`）。

**Trade-offs：**

- 真 P2P — 連線起來後流量不經過任何 server。適合「server 只當引介，之後客戶端直接 P2P」這種 fan-in / fan-out。
- 建立成本：真實網路 1-3 秒 ICE gathering + DTLS handshake（loopback 快很多）。
- Signaling server 要自己準備。library 給的是 `WebRtcSignalingChannel` 介面、walkthrough demo 用 in-process EventEmitter；browser 場景通常用 WebSocket signaling server。
- `node-datachannel` 是 native binding（libdatachannel + libsrtp + libjuice），安裝成本比純 JS transport 重。
- WebRTC 沒有 app-layer auth — 要做認證請放在 signaling 那層（user 控制 signaling channel），或在 `hello` envelope 階段交由 `auth_validator` 拒絕。
- **Shared mode**（`multi_access: "shared"`）在 WebRTC 上跟其它 transport 一樣：多個 peer 各自帶自己的 `WebRtcClient` + 自己的 signaling channel pair，連到同一個 `WebRtcServer` 對同一條 path。Server 端用 `peer_id` demux；per-path `SharedSessionRegistry` 做 refcount。你的 signaling adapter 要支援多 peer_id — 走 walkthrough 的 [`round10-webrtc-shared.js`](../note/walkthrough/round10-webrtc-shared.js) pattern（每個 client 一個 `make_client_channel(peer_id)`）。

**真實網路部署注意事項（TURN / NAT traversal）**

Walkthrough 那些數字（12.79 MB/s、0.67 ms p50）是**本機 loopback**，**不能**代表正式環境。準備上線前要意識到：

- **只靠 STUN 在多數企業 / mobile 網路上不夠**。Symmetric NAT（常見於企業防火牆、4G/5G 電信、旅館 Wi-Fi）沒辦法用 STUN 穿越。這種 peer 沒有 **TURN relay** 就連不起來。
- **TURN 會把 WebRTC 退化成中繼路徑** — 所有流量都會經過 TURN server，「真 P2P」優勢就沒了，還要付 TURN 的頻寬費用。throughput 跟 latency 數字會更接近 TCP relay 而不是直連 UDP。
- **ICE gathering 要花時間**：loopback ~ms 級、同 LAN ~100-300 ms、公網經 TURN candidate 1-3 秒、慢網路上 5-10 秒。
- **DTLS handshake** 還會再多一個 round-trip。
- **`ice_servers` 要同時帶 STUN 跟 TURN**：

  ```javascript
  ice_servers: [
      "stun:stun.l.google.com:19302",
      "turn:turn-user:turn-pass@turn.example.com:3478",
      "turns:turn-user:turn-pass@turn.example.com:5349",  // TURN over TLS
  ]
  ```

  自架可用 [coturn](https://github.com/coturn/coturn)，雲端服務有 Twilio NAT Traversal、Cloudflare TURN、Xirsys。免費 public STUN 沒問題；**免費 public TURN 不要用** — 都有流量限制或不穩定。
- **Library 不會幫你診斷 NAT 失敗**。peer 連不上 ICE 時，`WebRtcClient` 只是永遠不會到 `state === "open"`。在 app code 自己設 connection timeout，提示「WebRTC connection failed (check NAT/TURN config)」。
- **Signaling 是你自己的責任** — library 的 `WebRtcSignalingChannel` 只是協定形狀（offer/answer/candidate）。實際部署通常用一個小型 WebSocket signaling service 在 peer 之間轉訊息；walkthrough 用 in-process EventEmitter 只是因為測試裡沒有真的網路。

browser 當 peer 的場景，請看本 README 開頭的 Node-only 警告 — *signaling* 那端可以是 browser（browser 原生支援 WebRTC），但 *Node 端*的 connection 還是要跑這個 library。

### 協定（v2）

`serialport_handshake`（S→C）連上時宣告協定版本；client 比對相容性。協定版號 **2** 整段 v2 開發（P1-P5）不動。

Channel 表詳見 [Protocol (v2)](#protocol-v2) 英文段。

`RemoteSerialPortState`：`idle → opening → open → closing → closed`、加 `error`。

### 已知限制

- **MockBinding 沒有 removePort**（測試模式）：`@serialport/binding-mock` registry 沒有移除單一 port 的 API。`port_instance.close()` 釋放 lock 跟 stream，但 path 留在 process-wide registry 直到 `MockBinding.reset()`（`rsc.disconnect()` 無參數呼叫會做）。長時間跑、不同 path 一直建的 process 預期 registry 會緩慢增長到一次完整 disconnect。
- **Per-txn 成功/失敗 ack**：client `tx.end()` 在 `serialport_drain` 那刻 resolve。若 server 在 `_end` 抵達前 timeout 該 txn，後來的 `_end` 還是會收到 "unknown txn" 的 ack，所以 `tx.end()` 會「靜默 resolve 成成功」即使 bytes 沒到 device。server log（跟 `txn_timeout_action: 'state'/'both'`）才是 server 端偵測這個情況的方式。
- **IPC transport 是 single-endpoint**：一個 `MessagePort` pair 代表一條 client 連線，所以 `server.of(label)` / `server.mux(label)` 不管 label 都回同一條底層 transport。要在一條 IPC pair 上承載多埠請用 **mux mode**。多 endpoint IPC demux（envelope-level `ns` routing）在 P4 沒實作。

## License

MIT
