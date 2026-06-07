/**
 * Core domain types. The print job schema is the single contract shared by the
 * local WebSocket transport, the local HTTP transport, and the cloud relay.
 *
 * The runtime validators live in `schema.ts` (zod); these are the inferred /
 * hand-written TypeScript shapes used across the app.
 */

export type JobType = 'pdf' | 'escpos' | 'image' | 'html' | 'raw' | 'website'

/** Exactly one of these should be set. */
export interface JobSource {
  /** A URL the agent fetches (a PDF/image link), or for `website` jobs the page to render. */
  url?: string
  /** Base64-encoded bytes (PDF, image, or raw ESC/POS / ZPL payload). */
  base64?: string
  /** Inline text — HTML markup, raw ZPL/EPL, or a plain receipt body. */
  text?: string
  /** Absolute local file path the agent reads (PDF/image/raw). Gated by `allowFileSource`. */
  file?: string
}

export type PrinterTransport = 'queue' | 'network'

export interface JobPrinter {
  /** OS printer / queue name. Omit to use the agent's mapping or default. */
  name?: string
  /** 'queue' = Windows spooler (default), 'network' = raw TCP socket. */
  transport?: PrinterTransport
  /** Host for network transport (e.g. thermal printer on 9100). */
  host?: string
  /** Port for network transport (defaults to 9100). */
  port?: number
}

export type ScaleMode = number | 'noscale' | 'shrink' | 'fit'

export interface JobOptions {
  paperSize?: 'A4' | 'A5' | '58mm' | '80mm' | 'Letter' | (string & {})
  orientation?: 'portrait' | 'landscape'
  silent?: boolean
  duplex?: boolean
  scale?: ScaleMode
  monochrome?: boolean
  /** ESC/POS: cut the paper after printing (default true). */
  cut?: boolean
  /** ESC/POS: pulse the cash drawer. */
  openCashDrawer?: boolean
  /** ESC/POS character set (e.g. 'PC864_ARABIC', 'WPC1256'). */
  characterSet?: string
  /** HTML: render to PDF first, then print (exact paper metrics). */
  toPdfFirst?: boolean
  /** ESC/POS: characters per line override (32 for 58mm, 48 for 80mm). */
  width?: number
}

export interface JobMeta {
  building?: string
  terminal?: string
  user?: string
  docType?: string
  docId?: string | number
  label?: string
}

export interface PrintJob {
  v: number
  id: string
  type: JobType
  source: JobSource
  /** Optional structured payload (e.g. receipt line model) for escpos rendering. */
  data?: unknown
  printer?: JobPrinter
  /** Fan-out: print this job to every named printer in parallel. */
  printers?: string[]
  copies?: number
  options?: JobOptions
  meta?: JobMeta
  /** Epoch ms when the job was created — used for replay protection. */
  ts?: number
  /** Random per-job nonce — used for replay protection. */
  nonce?: string
  /** HMAC-SHA256 (hex) over the canonical job, using the pairing secret. */
  signature?: string
}

export type JobStatus = 'received' | 'queued' | 'printing' | 'printed' | 'failed'

export interface JobResult {
  v: number
  id: string
  status: 'printed' | 'failed'
  error?: string
  printer?: string
  durationMs?: number
  ts: number
}

export interface JobAck {
  v: number
  id: string
  status: 'received' | 'queued' | 'printing'
  ts: number
}

/** A printer as enumerated from the OS, surfaced to UI and clients. */
export interface PrinterInfo {
  name: string
  displayName?: string
  description?: string
  isDefault: boolean
  status?: number | string
}

/* ------------------------------------------------------------------ *
 * WebSocket message envelopes (browser <-> agent, local transport)
 * ------------------------------------------------------------------ */

export interface ClientPairMsg {
  kind: 'pair'
  origin?: string
  name?: string
}
export interface ClientJobMsg {
  kind: 'job'
  job: PrintJob
}
export interface ClientPrintersMsg {
  kind: 'printers'
}
export interface ClientPingMsg {
  kind: 'ping'
}
export type ClientMessage = ClientPairMsg | ClientJobMsg | ClientPrintersMsg | ClientPingMsg

export interface ServerHelloMsg {
  kind: 'hello'
  name: string
  version: string
  protocol: number
  paired: boolean
}
export interface ServerPairRequiredMsg {
  kind: 'pair_required'
  reason?: string
}
export interface ServerPairedMsg {
  kind: 'paired'
  /** Shared secret returned to the page exactly once. */
  secret: string
  agentId: string
}
export interface ServerPairDeniedMsg {
  kind: 'pair_denied'
}
export interface ServerPrintersMsg {
  kind: 'printers'
  printers: PrinterInfo[]
}
export interface ServerAckMsg extends JobAck {
  kind: 'ack'
}
export interface ServerResultMsg extends JobResult {
  kind: 'result'
}
export interface ServerErrorMsg {
  kind: 'error'
  id?: string
  error: string
}
export interface ServerPongMsg {
  kind: 'pong'
}
export type ServerMessage =
  | ServerHelloMsg
  | ServerPairRequiredMsg
  | ServerPairedMsg
  | ServerPairDeniedMsg
  | ServerPrintersMsg
  | ServerAckMsg
  | ServerResultMsg
  | ServerErrorMsg
  | ServerPongMsg

/* ------------------------------------------------------------------ *
 * Persisted settings
 * ------------------------------------------------------------------ */

export interface PairingRecord {
  secret: string
  approvedAt: number
  name?: string
}

/* ------------------------------------------------------------------ *
 * Multi-website registry
 * ------------------------------------------------------------------ */

export interface WebsiteRecord {
  origin: string
  name: string
  /** Per-site token (HMAC secret) — auto-generated, used to sign jobs. */
  token: string
  createdAt: number
  lastSeenAt: number
  /** Blocked sites are kept but cannot print. */
  blocked: boolean
}

/** One printed document in a website's history. */
export interface WebsiteJob {
  id: string
  type: string
  label?: string
  printer: string | null
  status: 'printed' | 'failed'
  error?: string
  durationMs?: number
  at: number
}

export type WebsiteEventKind = 'registered' | 'connected' | 'job' | 'error' | 'blocked' | 'revoked'

/** One entry in a website's activity log. */
export interface WebsiteEvent {
  at: number
  kind: WebsiteEventKind
  message: string
}

export interface CloudSettings {
  enabled: boolean
  baseUrl: string | null
  reverbKey: string | null
  reverbHost: string | null
  reverbPort: number | null
  reverbScheme: 'http' | 'https'
  building: string | null
  terminal: string | null
  token: string | null
}

export interface AgentSettings {
  /** Stable per-install id, also used as the agent/terminal identity hint. */
  agentId: string
  localPort: number
  enableWss: boolean
  defaultPrinter: string | null
  /** docType/format -> printer name. */
  printerMap: Record<string, string>
  /** Origins allowed without an interactive prompt. */
  allowedOrigins: string[]
  /** origin -> pairing secret. */
  pairings: Record<string, PairingRecord>
  cloud: CloudSettings
  startOnLogin: boolean
  minimizeToTray: boolean
  logLevel: 'error' | 'warn' | 'info' | 'debug'
  paused: boolean
  /** Max jobs printing at once across all printers (per-printer stays serial). */
  maxConcurrent: number
  /** Total attempts per job before it is marked failed (1 = no retry). */
  maxAttempts: number
  /** Delay before re-queueing a failed job. */
  retryBackoffMs: number
  /** How many finished jobs to keep in the visible history. */
  historyLimit: number
  /** Persist queued jobs to disk so they survive a restart. */
  persistQueue: boolean
  /** Allow jobs to print from a local file path (`source.file`). */
  allowFileSource: boolean
  /** Virtual "Terminal Printer" OS device that captures desktop print jobs over loopback. */
  virtualPrinter: VirtualPrinterSettings
}

export interface VirtualPrinterSettings {
  /** Run the loopback spool listener (the agent side of the virtual printer). */
  enabled: boolean
  /** Loopback TCP port the OS printer's RAW port targets. */
  listenPort: number
  /** What to do with a captured job: re-print it to the agent's default printer, or save it to a file. */
  route: 'default-printer' | 'save'
}
