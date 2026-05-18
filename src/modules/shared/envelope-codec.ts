/**
 * Length-prefix framing + JSON envelope codec, shared by all byte-stream transports
 * (raw TCP, UDS / Named Pipe, raw WebSocket, etc.).
 *
 * Wire frame:
 *
 *     [ 4 bytes BE total_len N ]
 *     [ N bytes payload ]
 *
 * Payload structure:
 *
 *     [ 4 bytes BE json_len J ]
 *     [ J bytes UTF-8 JSON envelope ]
 *     [ optional binary tail = (N - 4 - J) bytes ]
 *
 * When the binary tail is non-empty, the JSON envelope MUST have a `_binloc` field telling the
 * decoder where to graft the tail back onto the envelope:
 *
 *     `_binloc: "p"`      → graft tail at `env.p`         (e.g. `serialport_packet`)
 *     `_binloc: "p.data"` → graft tail at `env.p.data`    (e.g. mux packets / txn chunks)
 *
 * This avoids JSON-encoding Buffers as `{type:"Buffer",data:[...]}` which inflates 4 KB binary
 * to ~20 KB and tanks throughput. For non-Buffer envelopes the binary tail is absent and the
 * codec is just plain JSON.
 *
 * Envelope kinds:
 *
 *     `hello`  — client → server, opens a namespace. Carries `label` + optional `auth`.
 *     `msg`    — payload envelope for one wire-protocol channel.
 *     `ack`    — RPC-style ack response.
 *     `bye`    — graceful per-namespace close (mux only).
 */

export type Envelope =
    | { k: "hello"; label: string; auth?: unknown; ns?: string }
    | { k: "msg"; ns?: string; ch: string; p?: unknown; ack?: number; _binloc?: "p" | "p.data" }
    | { k: "ack"; ns?: string; ack: number; r?: unknown }
    | { k: "bye"; ns?: string };

const HEADER_BYTES = 4;
const JSON_LEN_BYTES = 4;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/**
 * Fallback reviver for non-hot-path Buffer encodings (deeply nested or unexpected shapes that
 * the binary-tail optimisation doesn't catch). Restores `{type:"Buffer", data:[...]}` to Buffer.
 */
function _revive_buffers(_key: string, value: unknown): unknown {
    if (value !== null && typeof value === "object"
        && (value as { type?: unknown }).type === "Buffer"
        && Array.isArray((value as { data?: unknown }).data)) {
        return Buffer.from((value as { data: number[] }).data);
    }
    return value;
}

/** Encode one envelope. Detects top-level / `p.data` Buffer fields and routes them through the
 *  binary tail; everything else goes through plain JSON. */
export function encode(env: Envelope): Buffer {
    let json_obj: any = env;
    let tail: Buffer | null = null;

    if (env.k === "msg" && env.p !== undefined && env.p !== null) {
        if (Buffer.isBuffer(env.p)) {
            tail = env.p;
            json_obj = { ...env, p: undefined, _binloc: "p" };
            delete (json_obj as any).p;
        } else if (typeof env.p === "object"
                   && Buffer.isBuffer((env.p as { data?: unknown }).data)) {
            tail = (env.p as { data: Buffer }).data;
            const p_without_data: any = { ...(env.p as object) };
            delete p_without_data.data;
            json_obj = { ...env, p: p_without_data, _binloc: "p.data" };
        }
    }

    const json: Buffer = Buffer.from(JSON.stringify(json_obj), "utf8");
    const tail_len: number = tail !== null ? tail.length : 0;
    const total: number = JSON_LEN_BYTES + json.length + tail_len;
    if (total > MAX_FRAME_BYTES) {
        throw new Error(`frame exceeds max size (${total} > ${MAX_FRAME_BYTES})`);
    }
    const out: Buffer = Buffer.allocUnsafe(HEADER_BYTES + total);
    out.writeUInt32BE(total, 0);
    out.writeUInt32BE(json.length, HEADER_BYTES);
    json.copy(out, HEADER_BYTES + JSON_LEN_BYTES);
    if (tail !== null) {
        tail.copy(out, HEADER_BYTES + JSON_LEN_BYTES + json.length);
    }
    return out;
}

/** Streaming frame decoder. Feed every incoming `data` chunk via `push`. */
export class FrameDecoder {
    private _buf: Buffer = Buffer.alloc(0);
    private readonly _on_envelope: (env: Envelope) => void;
    private readonly _on_error: (err: Error) => void;

    constructor(on_envelope: (env: Envelope) => void, on_error: (err: Error) => void) {
        this._on_envelope = on_envelope;
        this._on_error = on_error;
    }

    push(chunk: Buffer): void {
        this._buf = this._buf.length === 0 ? chunk : Buffer.concat([this._buf, chunk]);
        while (this._buf.length >= HEADER_BYTES) {
            const total: number = this._buf.readUInt32BE(0);
            if (total > MAX_FRAME_BYTES) {
                this._on_error(new Error(`oversized frame total=${total} (max=${MAX_FRAME_BYTES})`));
                this._buf = Buffer.alloc(0);
                return;
            }
            if (this._buf.length < HEADER_BYTES + total) {
                return;
            }
            const frame: Buffer = this._buf.subarray(HEADER_BYTES, HEADER_BYTES + total);
            this._buf = this._buf.subarray(HEADER_BYTES + total);

            if (frame.length < JSON_LEN_BYTES) {
                this._on_error(new Error(`frame too short for json_len header (${frame.length})`));
                continue;
            }
            const json_len: number = frame.readUInt32BE(0);
            if (frame.length < JSON_LEN_BYTES + json_len) {
                this._on_error(new Error(`frame truncated: json_len=${json_len} but only ${frame.length - JSON_LEN_BYTES} bytes available`));
                continue;
            }
            const json_bytes: Buffer = frame.subarray(JSON_LEN_BYTES, JSON_LEN_BYTES + json_len);
            const tail: Buffer | null = frame.length > JSON_LEN_BYTES + json_len
                ? frame.subarray(JSON_LEN_BYTES + json_len)
                : null;

            let env: Envelope;
            try {
                env = JSON.parse(json_bytes.toString("utf8"), _revive_buffers) as Envelope;
            } catch (e) {
                this._on_error(new Error(`malformed envelope JSON: ${(e as Error).message}`));
                continue;
            }
            if (tail !== null && env.k === "msg") {
                const binloc: string | undefined = (env as any)._binloc;
                if (binloc === "p") {
                    (env as any).p = tail;
                } else if (binloc === "p.data") {
                    if (typeof env.p !== "object" || env.p === null) (env as any).p = {};
                    ((env as any).p as { data: Buffer }).data = tail;
                }
                delete (env as any)._binloc;
            }
            // Dispatch outside the try/catch above so listener errors don't get mislabelled
            // as malformed envelopes.
            this._on_envelope(env);
        }
    }

    reset(): void {
        this._buf = Buffer.alloc(0);
    }
}
