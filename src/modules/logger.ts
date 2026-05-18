import { Logger } from "../types/remote-serialport-types/src/logger";

/* eslint-disable no-console */

/**
 * Default {@link Logger} used by the server when no logger is injected.
 *
 * - `warn` / `error` → `console.warn` / `console.error` with a `[remote-serialport-server]` prefix.
 * - `debug` / `info` → discarded (kept quiet for production).
 *
 * Inject your own via the server constructor's `logger` option to route to pino / winston / etc.
 */
export const default_logger: Logger = {
    debug: (): void => undefined,
    info: (): void => undefined,
    warn: (message: string, ...meta: unknown[]): void => {
        if (meta.length > 0) {
            console.warn(`[remote-serialport-server] ${message}`, ...meta);
        } else {
            console.warn(`[remote-serialport-server] ${message}`);
        }
    },
    error: (message: string, ...meta: unknown[]): void => {
        if (meta.length > 0) {
            console.error(`[remote-serialport-server] ${message}`, ...meta);
        } else {
            console.error(`[remote-serialport-server] ${message}`);
        }
    }
};
