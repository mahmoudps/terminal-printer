import { promises as fs } from 'node:fs'
import { userDataFile } from '../util/paths'
import { scoped } from '../util/log'

const log = scoped('outbox')

export interface OutboxItem {
  url: string
  body: unknown
  headers?: Record<string, string>
}

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
  }

  async add(item: OutboxItem): Promise<void> {
    this.items.push(item)
    await this.persist()
  }

  async flush(send: (item: OutboxItem) => Promise<void>): Promise<void> {
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
    await this.persist()
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
