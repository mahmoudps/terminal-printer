/**
 * IPC contract between the renderer (settings window) and the main process.
 * Channel names live here so preload and renderer stay in sync.
 */
import type {
  AgentSettings,
  CloudSettings,
  JobResult,
  JobType,
  PrinterInfo,
  WebsiteEvent,
  WebsiteJob,
} from './types'

// (queue + website view types declared below)

export const IPC = {
  getSettings: 'settings:get',
  setSettings: 'settings:set',
  setCloud: 'cloud:set',
  listPrinters: 'printers:list',
  testPrint: 'print:test',
  listPairings: 'pairings:list',
  revokePairing: 'pairings:revoke',
  getStatus: 'status:get',
  restartCloud: 'cloud:restart',
  restartServer: 'server:restart',
  getQueue: 'queue:get',
  cancelJob: 'queue:cancel',
  retryJob: 'queue:retry',
  clearQueueHistory: 'queue:clear',
  getLogs: 'logs:get',
  openLogs: 'logs:open',
  getWebsites: 'sites:list',
  getWebsiteDetail: 'sites:detail',
  revokeWebsite: 'sites:revoke',
  blockWebsite: 'sites:block',
  renameWebsite: 'sites:rename',
  regenerateToken: 'sites:regen',
  /** main -> renderer push */
  statusEvent: 'agent:status',
  queueEvent: 'agent:queue',
  logEvent: 'agent:log',
  websiteEvent: 'agent:sites',
} as const

export interface PairingView {
  origin: string
  approvedAt: number
  name?: string
}

export interface AgentStatus {
  version: string
  agentId: string
  serverPort: number
  serverRunning: boolean
  /** Set when the local server failed to start (e.g. all ports busy). */
  serverError?: string
  cloud: { state: string; detail?: string }
  paused: boolean
}

export type QueueState = 'queued' | 'printing' | 'done' | 'failed' | 'canceled'

/** A queue record as shown in the UI (never carries the payload). */
export interface QueueJobView {
  id: string
  type: string
  origin?: string
  printerName: string | null
  state: QueueState
  attempts: number
  maxAttempts: number
  error?: string
  label?: string
  enqueuedAt: number
  startedAt?: number
  finishedAt?: number
  durationMs?: number
}

export interface QueueSnapshot {
  active: QueueJobView[]
  queued: QueueJobView[]
  history: QueueJobView[]
  activeCount: number
  queuedCount: number
}

export interface WebsiteListItem {
  origin: string
  name: string
  blocked: boolean
  online: boolean
  createdAt: number
  lastSeenAt: number
  jobCount: number
}

export interface WebsiteDetail {
  origin: string
  name: string
  token: string
  blocked: boolean
  online: boolean
  createdAt: number
  lastSeenAt: number
  jobs: WebsiteJob[]
  events: WebsiteEvent[]
}

/** The API exposed on `window.agent` by the preload bridge. */
export interface AgentBridge {
  getSettings(): Promise<AgentSettings>
  setSettings(patch: Partial<AgentSettings>): Promise<AgentSettings>
  setCloud(patch: Partial<CloudSettings>): Promise<AgentSettings>
  listPrinters(): Promise<PrinterInfo[]>
  testPrint(type: JobType): Promise<JobResult>
  getStatus(): Promise<AgentStatus>
  restartCloud(): Promise<void>
  restartServer(): Promise<void>
  getQueue(): Promise<QueueSnapshot>
  cancelJob(id: string): Promise<void>
  retryJob(id: string): Promise<void>
  clearQueueHistory(): Promise<void>
  getLogs(): Promise<string[]>
  openLogs(): Promise<void>
  getWebsites(): Promise<WebsiteListItem[]>
  getWebsiteDetail(origin: string): Promise<WebsiteDetail | null>
  revokeWebsite(origin: string): Promise<void>
  blockWebsite(origin: string, blocked: boolean): Promise<void>
  renameWebsite(origin: string, name: string): Promise<void>
  regenerateToken(origin: string): Promise<void>
  onStatus(cb: (status: AgentStatus) => void): () => void
  onQueue(cb: (snapshot: QueueSnapshot) => void): () => void
  onLog(cb: (lines: string[]) => void): () => void
  onWebsites(cb: (sites: WebsiteListItem[]) => void): () => void
}
