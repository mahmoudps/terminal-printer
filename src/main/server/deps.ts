import type { PrintEngine } from '../printing'
import type { NonceCache } from '../security/nonce'
import type { ConfigStore } from '../config/store'
import type { WebsiteRegistry } from '../websites/registry'

/** Everything the HTTP + WS handlers need, injected by the orchestrator. */
export interface ServerDeps {
  engine: PrintEngine
  registry: WebsiteRegistry
  nonces: NonceCache
  store: ConfigStore
}
