import { randomUUID } from "crypto";
import { connect as mqttConnect, MqttClient, IClientOptions } from "mqtt";

import {
    AbsTransport,
    AbsTransportEndpoint,
    AbsTransportServer,
    TransportAckCallback,
    TransportLifecycleEvent,
    TransportMessageListener
} from "../types/remote-serialport-types/src/transport";
import { Logger } from "../types/remote-serialport-types/src/logger";
import { default_logger } from "./logger";
import { Envelope, FrameDecoder, encode } from "./shared/envelope-codec";

/**
 * MQTT transport — broker pattern. The server (this) connects to an MQTT broker as a regular
 * client and subscribes to a topic family that clients publish into. Each (client_id, namespace)
 * pair becomes one logical {@link AbsTransport}.
 *
 * Topic conventions (with default `topic_prefix = "rsp"`):
 *
 *     <prefix>/c2s/<client_id>/<namespace>     client → server (incl. `hello` envelope)
 *     <prefix>/s2c/<client_id>/<namespace>     server → client
 *
 * Client connects with a UUID `client_id`, sends a `hello` envelope on its c2s topic; the server
 * sees it, materialises a transport, and the user's `on("connection")` fires. From then on each
 * client publishes c2s envelopes and consumes s2c envelopes for that namespace.
 *
 * NOTE: this transport requires an external MQTT broker (mosquitto, EMQX, HiveMQ, …). The
 * walkthrough spins up `aedes` in-process for tests, so you don't need to run anything externally
 * to try it.
 */

export interface MqttServerOptions {
    /** Broker URL (e.g. `mqtt://localhost:1883`, `mqtts://broker:8883`). */
    broker_url: string;
    /** Topic prefix shared between server and clients. Default `"rsp"`. */
    topic_prefix?: string;
    /** Stable identifier for this server instance in the broker. Default: random UUID. */
    server_id?: string;
    /** QoS for both directions. Default 1 (at-least-once). 0 will drop messages on network blip
     *  and corrupt the serial stream. */
    qos?: 0 | 1 | 2;
    /** Forwarded to `mqtt.connect` — auth, TLS, keepalive, etc. */
    mqtt_options?: IClientOptions;
    logger?: Logger;
}

class MqttServerTransport extends AbsTransport {
    private readonly _id: string;
    private readonly _label: string;
    private readonly _client_id: string;
    private readonly _credential: unknown;
    private readonly _publish: (frame: Buffer) => void;
    private _connected = true;
    private readonly _channel_listeners: Map<string, Set<TransportMessageListener>> = new Map();
    private readonly _lifecycle: Map<TransportLifecycleEvent, Set<(...a: any[]) => void>> = new Map();
    private readonly _pending_rpcs: Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = new Map();
    private _next_ack = 1;

    constructor(label: string, client_id: string, credential: unknown, publish: (frame: Buffer) => void) {
        super();
        this._id = randomUUID();
        this._label = label;
        this._client_id = client_id;
        this._credential = credential;
        this._publish = publish;
        // F13: setImmediate (not process.nextTick) for sync + Promise.then + await symmetry.
        setImmediate(() => this._fire_lifecycle("connect"));
    }

    get id(): string { return this._id; }
    get is_connected(): boolean { return this._connected; }
    get endpoint_label(): string { return this._label; }
    get credential(): unknown { return this._credential; }
    get client_id(): string { return this._client_id; }

    send(channel: string, payload?: unknown): void {
        if (this._connected === false) return;
        this._publish(encode({ k: "msg", ch: channel, p: payload }));
    }

    send_rpc(channel: string, payload: unknown, timeout_ms: number): Promise<unknown> {
        return new Promise<unknown>((resolve, reject) => {
            if (this._connected === false) { reject(new Error("transport closed")); return; }
            const ack_id: number = this._next_ack++;
            const timer = setTimeout(() => {
                this._pending_rpcs.delete(ack_id);
                reject(new Error(`RPC "${channel}" timed out after ${timeout_ms}ms`));
            }, timeout_ms);
            this._pending_rpcs.set(ack_id, { resolve, reject, timer });
            this._publish(encode({ k: "msg", ch: channel, p: payload, ack: ack_id }));
        });
    }

    on(channel: string, listener: TransportMessageListener): void {
        let s = this._channel_listeners.get(channel);
        if (s === undefined) { s = new Set(); this._channel_listeners.set(channel, s); }
        s.add(listener);
    }
    once(channel: string, listener: TransportMessageListener): void {
        const w: TransportMessageListener = (p, a) => { this.off(channel, w); listener(p, a); };
        this.on(channel, w);
    }
    off(channel: string, listener?: TransportMessageListener): void {
        if (listener === undefined) { this._channel_listeners.delete(channel); return; }
        this._channel_listeners.get(channel)?.delete(listener);
    }
    on_lifecycle(e: TransportLifecycleEvent, l: (...a: any[]) => void): void {
        let s = this._lifecycle.get(e); if (s === undefined) { s = new Set(); this._lifecycle.set(e, s); } s.add(l);
    }
    off_lifecycle(e: TransportLifecycleEvent, l: (...a: any[]) => void): void { this._lifecycle.get(e)?.delete(l); }

    get_buffered_amount(): number | null { return null; /* MQTT client doesn't expose this */ }

    close(): void {
        if (this._connected === false) return;
        this._publish(encode({ k: "bye" }));
        this._on_remote_close();
    }

    /** @internal */
    _dispatch_envelope(env: Envelope): void {
        if (env.k === "msg") {
            const listeners = this._channel_listeners.get(env.ch);
            if (listeners === undefined || listeners.size === 0) return;
            const ack_id: number | undefined = typeof env.ack === "number" ? env.ack : undefined;
            const ack_cb: TransportAckCallback | undefined = ack_id !== undefined
                ? (r) => this._publish(encode({ k: "ack", ack: ack_id, r }))
                : undefined;
            for (const l of listeners) { try { l(env.p, ack_cb); } catch { /* isolated */ } }
            return;
        }
        if (env.k === "ack") {
            const p = this._pending_rpcs.get(env.ack);
            if (p === undefined) return;
            clearTimeout(p.timer);
            this._pending_rpcs.delete(env.ack);
            p.resolve(env.r);
            return;
        }
        if (env.k === "bye") { this._on_remote_close(); return; }
    }

    /** @internal */
    _on_remote_close(): void {
        if (this._connected === false) return;
        this._connected = false;
        for (const [, p] of this._pending_rpcs) { clearTimeout(p.timer); p.reject(new Error("transport closed")); }
        this._pending_rpcs.clear();
        this._fire_lifecycle("disconnect");
    }

    private _fire_lifecycle(event: TransportLifecycleEvent, ...args: any[]): void {
        const set = this._lifecycle.get(event);
        if (set === undefined) return;
        for (const l of set) { try { l(...args); } catch { /* */ } }
    }
}

class MqttEndpoint extends AbsTransportEndpoint {
    private readonly _label: string | RegExp;
    private _listener: ((t: AbsTransport) => void) | null = null;
    private readonly _pending: AbsTransport[] = [];
    private readonly _transports: Set<AbsTransport> = new Set();

    constructor(label: string | RegExp) { super(); this._label = label; }
    get label(): string | RegExp { return this._label; }

    on_connection(listener: (transport: AbsTransport) => void): void {
        this._listener = listener;
        while (this._pending.length > 0) this._fire(this._pending.shift()!);
    }

    accept(transport: AbsTransport): void {
        this._transports.add(transport);
        transport.on_lifecycle("disconnect", () => this._transports.delete(transport));
        if (this._listener === null) { this._pending.push(transport); return; }
        this._fire(transport);
    }

    private _fire(t: AbsTransport): void { try { this._listener!(t); } catch { /* swallow */ } }

    matches(label: string): boolean {
        return typeof this._label === "string" ? this._label === label : this._label.test(label);
    }

    close_all(): void {
        for (const t of this._transports) { try { (t as any).close?.(); } catch {} }
        this._transports.clear();
    }
}

export class MqttServer extends AbsTransportServer {
    private readonly _opts: MqttServerOptions;
    private readonly _prefix: string;
    private readonly _qos: 0 | 1 | 2;
    private readonly _server_id: string;
    private readonly _logger: Logger;
    private _client: MqttClient | null = null;
    private readonly _endpoints: Map<string, MqttEndpoint> = new Map();
    /** Per (client_id, namespace) transport map. */
    private readonly _transports: Map<string, MqttServerTransport> = new Map();
    private _listening = false;

    constructor(opts: MqttServerOptions) {
        super();
        this._opts = opts;
        this._prefix = opts.topic_prefix ?? "rsp";
        this._qos = opts.qos ?? 1;
        this._server_id = opts.server_id ?? randomUUID();
        this._logger = opts.logger ?? default_logger;
    }

    private _key(client_id: string, label: string): string { return `${client_id}::${label}`; }

    listen(_port?: number): void {
        if (this._listening === true) return;
        this._listening = true;
        this._client = mqttConnect(this._opts.broker_url, {
            clientId: `rsp-server-${this._server_id}`,
            clean: true,
            ...this._opts.mqtt_options
        });
        this._client.on("connect", () => {
            // `+` = single level (client_id), `#` = multi-level (label can contain slashes such as
            // `/dev/ttyUSB0`). Without `#` the wildcard fails to match labels with embedded `/`.
            const wildcard = `${this._prefix}/c2s/+/#`;
            this._client!.subscribe(wildcard, { qos: this._qos }, (err) => {
                if (err !== null && err !== undefined) this._logger.error(`mqtt subscribe failed: ${err.message}`);
            });
        });
        this._client.on("message", (topic: string, payload: Buffer) => this._on_message(topic, payload));
        this._client.on("error", (err) => this._logger.warn(`mqtt server error: ${err.message}`));
    }

    private _on_message(topic: string, payload: Buffer): void {
        // topic: <prefix>/c2s/<client_id>/<label>
        const parts: string[] = topic.split("/");
        if (parts.length < 4 || parts[0] !== this._prefix || parts[1] !== "c2s") return;
        const client_id: string = parts[2];
        const label: string = parts.slice(3).join("/");

        // One-shot decode (MQTT delivered the whole frame as one message)
        const decoder = new FrameDecoder(
            (env) => this._dispatch(client_id, label, env),
            (err) => this._logger.warn(`mqtt decode: ${err.message}`)
        );
        decoder.push(payload);
    }

    private _dispatch(client_id: string, label: string, env: Envelope): void {
        const key: string = this._key(client_id, label);

        if (env.k === "hello") {
            if (this._transports.has(key)) {
                this._logger.warn(`mqtt: duplicate hello for ${key}; ignoring`);
                return;
            }
            const endpoint: MqttEndpoint | null = this._find_endpoint(label);
            if (endpoint === null) {
                this._logger.warn(`mqtt: hello for unregistered endpoint "${label}"; ignoring`);
                return;
            }
            const s2c_topic: string = `${this._prefix}/s2c/${client_id}/${label}`;
            const publish = (frame: Buffer): void => {
                if (this._client === null) return;
                this._client.publish(s2c_topic, frame, { qos: this._qos });
            };
            const transport: MqttServerTransport = new MqttServerTransport(label, client_id, env.auth, publish);
            this._transports.set(key, transport);
            transport.on_lifecycle("disconnect", () => this._transports.delete(key));
            endpoint.accept(transport);
            return;
        }

        const t: MqttServerTransport | undefined = this._transports.get(key);
        if (t === undefined) {
            this._logger.warn(`mqtt: ${env.k} for unknown client/ns "${key}"; ignoring (no hello yet?)`);
            return;
        }
        t._dispatch_envelope(env);
    }

    private _find_endpoint(label: string): MqttEndpoint | null {
        for (const ep of this._endpoints.values()) if (ep.matches(label)) return ep;
        return null;
    }

    of(label: string | RegExp): AbsTransportEndpoint {
        const key: string = typeof label === "string" ? label : label.toString();
        const existing = this._endpoints.get(key);
        if (existing !== undefined) return existing;
        const ep = new MqttEndpoint(label);
        this._endpoints.set(key, ep);
        return ep;
    }

    close(): void {
        // D6: mirror D3's client-side fix — call each transport's `close()` so it publishes
        // its `bye` envelope on the s2c topic before we end the broker connection. Without
        // this, MQTT clients only learn the server is gone after the broker's keepalive
        // expires (~60 s) instead of immediately.
        for (const t of this._transports.values()) { try { t.close(); } catch {} }
        this._transports.clear();
        this._endpoints.clear();
        if (this._client !== null) {
            const client = this._client;
            this._client = null;
            // Graceful end (force=false) so the queued bye publishes drain; fall back to
            // force-end after 1 s in case the broker is unresponsive.
            let done = false;
            const finalize = (): void => { if (done) return; done = true; try { client.end(true); } catch {} };
            try { client.end(false, {}, finalize); } catch { finalize(); }
            const t = setTimeout(finalize, 1000);
            if (typeof (t as { unref?: () => void }).unref === "function") (t as { unref: () => void }).unref();
        }
        this._listening = false;
    }
}
