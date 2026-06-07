import type { JobResult, JobType } from '@shared/types'
import type { AgentStatus, DiagReport, HealthStats } from '@shared/ipc'
import type { ConfigStore } from './config/store'
import type { PrintEngine } from './printing'
import type { LocalServer } from './server'
import type { CloudClient } from './cloud/client'
import type { WebsiteRegistry } from './websites/registry'

/** Shared services + actions wired up in main/index.ts and used by tray/IPC. */
export interface AppContext {
  store: ConfigStore
  engine: PrintEngine
  server: LocalServer
  cloud: CloudClient
  registry: WebsiteRegistry

  restartServer(): Promise<void>
  stopServer(): Promise<void>
  broadcastStatus(): void
  getStatus(): AgentStatus
  refreshTray(): void

  openSettings(): void
  openLogs(): void
  printFile(): Promise<void>
  testPrint(type: JobType): Promise<JobResult>
  runDiagnostics(): Promise<DiagReport>
  getHealth(): HealthStats
  setStartOnLogin(open: boolean): Promise<void>
  quit(): void
}
