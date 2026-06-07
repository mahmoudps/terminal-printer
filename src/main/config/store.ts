import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { AgentSettings, CloudSettings, PairingRecord } from '@shared/types'
import { DEFAULT_LOCAL_PORT } from '@shared/constants'
import { userDataFile } from '../util/paths'
import { scoped } from '../util/log'

const log = scoped('config')

function defaultCloud(): CloudSettings {
  return {
    enabled: false,
    baseUrl: null,
    reverbKey: null,
    reverbHost: null,
    reverbPort: null,
    reverbScheme: 'https',
    building: null,
    terminal: null,
    token: null,
  }
}

function defaults(): AgentSettings {
  return {
    agentId: randomUUID(),
    localPort: DEFAULT_LOCAL_PORT,
    enableWss: false,
    defaultPrinter: null,
    printerMap: {},
    allowedOrigins: [],
    pairings: {},
    cloud: defaultCloud(),
    startOnLogin: true,
    minimizeToTray: true,
    logLevel: 'info',
    paused: false,
    maxConcurrent: 3,
    maxAttempts: 2,
    retryBackoffMs: 3000,
    historyLimit: 100,
    persistQueue: true,
    allowFileSource: true,
    virtualPrinter: { enabled: false, listenPort: 9101, route: 'default-printer' },
  }
}

/**
 * Tiny JSON-backed settings store in userData. Dependency-free (no electron-store)
 * to keep the bundle native-module-free. Writes are serialized + atomic-ish
 * (write temp then rename).
 */
export class ConfigStore extends EventEmitter {
  private settings: AgentSettings = defaults()
  private file = ''
  private queue: Promise<void> = Promise.resolve()

  async load(): Promise<void> {
    this.file = userDataFile('config.json')
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<AgentSettings>
      // Merge over defaults so new fields appear after upgrades.
      this.settings = {
        ...defaults(),
        ...parsed,
        cloud: { ...defaultCloud(), ...(parsed.cloud ?? {}) },
        virtualPrinter: { ...defaults().virtualPrinter, ...(parsed.virtualPrinter ?? {}) },
        printerMap: { ...(parsed.printerMap ?? {}) },
        pairings: { ...(parsed.pairings ?? {}) },
        allowedOrigins: parsed.allowedOrigins ?? [],
        // never inherit a stale generated id if file lacked one
        agentId: parsed.agentId ?? defaults().agentId,
      }
      log.info('loaded config from', this.file)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        log.warn('config read failed, using defaults:', String(err))
      }
      await this.persist()
    }
  }

  get(): AgentSettings {
    return this.settings
  }

  /** Shallow-merge top-level fields (does not deep-merge nested objects). */
  async update(patch: Partial<AgentSettings>): Promise<AgentSettings> {
    this.settings = { ...this.settings, ...patch }
    await this.persist()
    this.emit('change', this.settings, patch)
    return this.settings
  }

  async setCloud(patch: Partial<CloudSettings>): Promise<AgentSettings> {
    this.settings = { ...this.settings, cloud: { ...this.settings.cloud, ...patch } }
    await this.persist()
    this.emit('change', this.settings, { cloud: this.settings.cloud })
    return this.settings
  }

  async setPrinterMap(map: Record<string, string>): Promise<AgentSettings> {
    return this.update({ printerMap: { ...map } })
  }

  async addPairing(origin: string, record: PairingRecord): Promise<void> {
    this.settings.pairings = { ...this.settings.pairings, [origin]: record }
    if (!this.settings.allowedOrigins.includes(origin)) {
      this.settings.allowedOrigins = [...this.settings.allowedOrigins, origin]
    }
    await this.persist()
    this.emit('change', this.settings, { pairings: this.settings.pairings })
  }

  async removePairing(origin: string): Promise<void> {
    const { [origin]: _removed, ...rest } = this.settings.pairings
    this.settings.pairings = rest
    this.settings.allowedOrigins = this.settings.allowedOrigins.filter((o) => o !== origin)
    await this.persist()
    this.emit('change', this.settings, { pairings: this.settings.pairings })
  }

  pairingFor(origin: string): PairingRecord | undefined {
    return this.settings.pairings[origin]
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.settings, null, 2)
    // Serialize writes to avoid interleaving. Run the next write whether or not
    // the previous one rejected, and keep `this.queue` resolved — otherwise a
    // single transient write failure would poison the chain and silently drop
    // every future config write.
    const run = this.queue.then(
      () => this.writeFile(snapshot),
      () => this.writeFile(snapshot),
    )
    this.queue = run.catch(() => undefined)
    return run // callers still see *this* write's success/failure
  }

  private async writeFile(snapshot: string): Promise<void> {
    const tmp = this.file + '.tmp'
    await fs.writeFile(tmp, snapshot, 'utf8')
    await fs.rename(tmp, this.file)
  }
}

export type { AgentSettings }
