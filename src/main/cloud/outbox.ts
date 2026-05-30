import { promises as fs } from 'node:fs'
import { userDataFile } from '../util/paths'
import { scoped } from '../util/log'

const log = scoped('outbox')

export interface OutboxItem {
  url: string
  body: unknown
  headers?: Record<string, string>
  at?: number // enqueue time, for TTL pruning
}

const OUTBOX_CAP = 500 // max items kept (drops oldest beyond this)
const OUTBOX_TTL_MS = 24 * 60 * 60 * 1000 // discard status callbacks older than a day

/**
 * Durable queue of status callbacks that failed to POST (e.g. during a network
 * blip). Flushed when the cloud connection comes back.
 */
export class Outbox {
  private items: OutboxItem[] = []
  private file = ''

  async load(): Promise<void> {
    this.file = userDataFile('outbox.json')
    try {
      this.items = JSON.parse(await fs.readFile(this.file, 'utf8'))
    } catch {
      this.items = []
    }
    this.prune()
  }

  async add(item: OutboxItem): Promise<void> {
    this.items.push({ ...item, at: item.at ?? Date.now() })
    this.prune()
    await this.persist()
  }

  async flush(send: (item: OutboxItem) => Promise<void>): Promise<void> {
    this.prune()
    if (!this.items.length) return
    const pending = this.items
    this.items = []
    const failed: OutboxItem[] = []
    for (const item of pending) {
      try {
        await send(item)
      } catch (err) {
        log.warn('flush item failed, re-queueing:', String(err))
        failed.push(item)
      }
    }
    this.items = failed
    this.prune()
    await this.persist()
  }

  /** Drop expired items and cap the backlog so it can never grow unbounded. */
  private prune(): void {
    const cutoff = Date.now() - OUTBOX_TTL_MS
    const before = this.items.length
    this.items = this.items.filter((i) => (i.at ?? 0) >= cutoff)
    if (this.items.length > OUTBOX_CAP) this.items = this.items.slice(-OUTBOX_CAP)
    const dropped = before - this.items.length
    if (dropped > 0) log.warn(`dropped ${dropped} stale/overflowing outbox item(s)`)
  }

  private async persist(): Promise<void> {
    if (!this.file) return
    try {
      await fs.writeFile(this.file, JSON.stringify(this.items))
    } catch (err) {
      log.warn('persist failed:', String(err))
    }
  }
}
