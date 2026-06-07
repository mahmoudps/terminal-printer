import type { PrintEngine } from '../printing'
import type { NonceCache } from '../security/nonce'
import type { ConfigStore } from '../config/store'
import type { WebsiteRegistry } from '../websites/registry'
import type { DiagReport } from '@shared/ipc'

/** Everything the HTTP + WS handlers need, injected by the orchestrator. */
export interface ServerDeps {
  engine: PrintEngine
  registry: WebsiteRegistry
  nonces: NonceCache
  store: ConfigStore
  /** Build a self-diagnosis report (exposed at GET /diagnostics for the CLI). */
  getDiagnostics?: () => Promise<DiagReport>
}
