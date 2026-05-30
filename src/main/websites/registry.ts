import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import type { WebsiteRecord, WebsiteJob, WebsiteEvent, WebsiteEventKind } from '@shared/types'
import type { WebsiteDetail, WebsiteListItem } from '@shared/ipc'
import { userDataFile } from '../util/paths'
import { scoped } from '../util/log'
import { generateSecret } from '../security/hmac'

const log = scoped('sites')
const JOB_CAP = 200
const EVENT_CAP = 150

interface SiteData {
  record: WebsiteRecord
  jobs: WebsiteJob[]
  events: WebsiteEvent[]
}

/**
 * Tracks every website that talks to the agent. New origins are auto-approved
 * (per the user's choice) and issued a per-site token; each site is isolated
 * with its own token, printed-files history, and activity log.
 */
export class WebsiteRegistry extends EventEmitter {
  private sites = new Map<string, SiteData>()
  private online = new Map<string, number>() // origin -> open session count
  private file = ''
  private saveTimer: NodeJS.Timeout | null = null

  async load(): Promise<void> {
    this.file = userDataFile('websites.json')
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as { sites?: Record<string, SiteData> }
      for (const [origin, data] of Object.entries(parsed.sites ?? {})) {
        this.sites.set(origin, { record: data.record, jobs: data.jobs ?? [], events: data.events ?? [] })
      }
      log.info(`loaded ${this.sites.size} website(s)`)
    } catch {
      /* fresh */
    }
  }

  /** Auto-approve + register an origin (or refresh it). Returns null if blocked. */
  ensure(origin: string | undefined): WebsiteRecord | null {
    if (!origin) return null
    let site = this.sites.get(origin)
    if (site) {
      if (site.record.blocked) return null
      site.record.lastSeenAt = Date.now()
      this.changed()
      return site.record
    }
    const record: WebsiteRecord = {
      origin,
      name: hostnameOf(origin),
      token: generateSecret(),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      blocked: false,
    }
    site = { record, jobs: [], events: [] }
    this.sites.set(origin, site)
    this.pushEvent(site, 'registered', 'Auto-approved and issued a token')
    log.info(`auto-registered ${origin}`)
    this.changed()
    return record
  }

  tokenFor(origin: string | undefined): string | undefined {
    return origin ? this.sites.get(origin)?.record.token : undefined
  }

  isBlocked(origin: string | undefined): boolean {
    return !!(origin && this.sites.get(origin)?.record.blocked)
  }

  /** Returns true if this connection was counted (so the matching close can decrement). */
  markConnected(origin: string | undefined): boolean {
    if (!origin) return false
    const rec = this.ensure(origin)
    if (!rec) return false
    this.online.set(origin, (this.online.get(origin) ?? 0) + 1)
    const site = this.sites.get(origin)
    if (site) this.pushEvent(site, 'connected', 'WebSocket connected')
    this.changed()
    return true
  }

  markDisconnected(origin: string | undefined): void {
    if (!origin) return
    const cur = this.online.get(origin)
    if (cur == null) return // wasn't counted — don't drift negative
    const n = cur - 1
    if (n <= 0) this.online.delete(origin)
    else this.online.set(origin, n)
    this.changed()
  }

  recordJob(origin: string | undefined, job: WebsiteJob): void {
    if (!origin) return
    // Only real, already-registered websites get history. Synthetic origins like
    // 'cloud'/'desktop' are not websites and must not auto-create token entries.
    const site = this.sites.get(origin)
    if (!site) return
    site.jobs.unshift(job)
    if (site.jobs.length > JOB_CAP) site.jobs.length = JOB_CAP
    site.record.lastSeenAt = Date.now()
    this.pushEvent(
      site,
      job.status === 'printed' ? 'job' : 'error',
      `${job.status} ${job.type}${job.label ? ' — ' + job.label : ''}${job.error ? ': ' + job.error : ''}`,
    )
    this.changed()
  }

  setBlocked(origin: string, blocked: boolean): void {
    const site = this.sites.get(origin)
    if (!site) return
    site.record.blocked = blocked
    this.pushEvent(site, 'blocked', blocked ? 'Blocked' : 'Unblocked')
    this.changed()
  }

  rename(origin: string, name: string): void {
    const site = this.sites.get(origin)
    if (!site) return
    site.record.name = name.slice(0, 80) || site.record.name
    this.changed()
  }

  regenerateToken(origin: string): void {
    const site = this.sites.get(origin)
    if (!site) return
    site.record.token = generateSecret()
    this.pushEvent(site, 'registered', 'Token regenerated')
    this.changed()
  }

  remove(origin: string): void {
    if (this.sites.delete(origin)) {
      this.online.delete(origin)
      log.info(`revoked ${origin}`)
      this.changed()
    }
  }

  list(): WebsiteListItem[] {
    return [...this.sites.values()]
      .map((s) => ({
        origin: s.record.origin,
        name: s.record.name,
        blocked: s.record.blocked,
        online: (this.online.get(s.record.origin) ?? 0) > 0,
        createdAt: s.record.createdAt,
        lastSeenAt: s.record.lastSeenAt,
        jobCount: s.jobs.length,
      }))
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  }

  detail(origin: string): WebsiteDetail | null {
    const s = this.sites.get(origin)
    if (!s) return null
    return {
      origin: s.record.origin,
      name: s.record.name,
      token: s.record.token,
      blocked: s.record.blocked,
      online: (this.online.get(origin) ?? 0) > 0,
      createdAt: s.record.createdAt,
      lastSeenAt: s.record.lastSeenAt,
      jobs: s.jobs,
      events: [...s.events].reverse(),
    }
  }

  private pushEvent(site: SiteData, kind: WebsiteEventKind, message: string): void {
    site.events.push({ at: Date.now(), kind, message })
    if (site.events.length > EVENT_CAP) site.events.splice(0, site.events.length - EVENT_CAP)
  }

  /** Flush any pending debounced write immediately (used on shutdown). */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    await this.persist()
  }

  private changed(): void {
    this.emit('update')
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.persist()
    }, 400)
  }

  private async persist(): Promise<void> {
    if (!this.file) return
    const sites: Record<string, SiteData> = {}
    for (const [origin, s] of this.sites) sites[origin] = s
    try {
      const tmp = this.file + '.tmp'
      await fs.writeFile(tmp, JSON.stringify({ version: 1, sites }))
      await fs.rename(tmp, this.file)
    } catch (err) {
      log.warn('persist failed:', String(err))
    }
  }
}

function hostnameOf(origin: string): string {
  try {
    return new URL(origin).host || origin
  } catch {
    return origin
  }
}
