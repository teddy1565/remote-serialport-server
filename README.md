# Remote-Serialport

> **Language**: [English](#english) · [中文](#中文)

<a id="english"></a>

## English

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

This library doesn't wrap transports in TLS. For socket.io, configure HTTPS at the http server
layer (pass it into `Server` via `socket_server_options`). For IPC, use OS-level sandbox / process
isolation. mTLS is delegated to `https.createServer({requestCert: true, ...})`.

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

<a id="中文"></a>

## 中文

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

Library 本身不加密 transport。socket.io：在 http server layer 用 HTTPS（透過 `socket_server_options` 把 https.Server 注入）。IPC：靠 OS-level sandbox / process isolation。mTLS：交給 `https.createServer({requestCert: true, ...})`。

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
