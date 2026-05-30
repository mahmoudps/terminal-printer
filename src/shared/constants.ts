/**
 * Constants shared across the whole agent (main, preload, renderer).
 * Keep this dependency-free so any layer can import it.
 */

/** Bump when the wire protocol changes in a breaking way. */
export const PROTOCOL_VERSION = 1 as const

/** Primary loopback port the local server binds to. */
export const DEFAULT_LOCAL_PORT = 9120

/** Ports a browser SDK probes, in order. Keep in sync with the building.dev SDK. */
export const LOCAL_PORTS = [9120, 9121, 9122]

/** WebSocket upgrade path on the local server. */
export const WS_PATH = '/ws'

/** Replay window: a signed job's `ts` must be within this many ms of now. */
export const REPLAY_WINDOW_MS = 60_000

/** How long a seen nonce is remembered (should be >= REPLAY_WINDOW_MS). */
export const NONCE_TTL_MS = 120_000

/** Default heartbeat interval to the cloud relay. */
export const CLOUD_HEARTBEAT_MS = 30_000

/** Max cloud reconnect backoff. */
export const CLOUD_BACKOFF_MAX_MS = 30_000

/** Document types the agent understands for printer-map resolution. */
export const KNOWN_DOC_TYPES = ['receipt', 'invoice', 'statement', 'report', 'label', 'default'] as const

/** Queued jobs whose payload exceeds this are not persisted across restarts. */
export const MAX_PERSIST_PAYLOAD_BYTES = 1024 * 1024

/** How many recent log lines to keep in memory for the in-GUI viewer. */
export const LOG_BUFFER_SIZE = 500
