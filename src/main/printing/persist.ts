import { promises as fs } from 'node:fs'
import { MAX_PERSIST_PAYLOAD_BYTES } from '@shared/constants'
import { userDataFile } from '../util/paths'
import { scoped } from '../util/log'
import type { QueueRecord } from './queue'

const log = scoped('queue-persist')
const file = (): string => userDataFile('queue.json')

function payloadSize(rec: QueueRecord): number {
  const s = rec.job.source
  return (s.base64?.length ?? 0) + (s.text?.length ?? 0) + (s.url?.length ?? 0) + (s.file?.length ?? 0)
}

async function write(queued: QueueRecord[]): Promise<void> {
  const keep = queued.filter((r) => payloadSize(r) <= MAX_PERSIST_PAYLOAD_BYTES)
  const dropped = queued.length - keep.length
  if (dropped) log.warn(`${dropped} oversized job(s) not persisted across restart`)
  const data = keep.map((r) => ({
    id: r.id,
    type: r.type,
    origin: r.origin,
    printerKey: r.printerKey,
    printerName: r.printerName,
    attempts: 0,
    maxAttempts: r.maxAttempts,
    label: r.label,
    enqueuedAt: r.enqueuedAt,
    job: r.job,
  }))
  try {
    const tmp = file() + '.tmp'
    await fs.writeFile(tmp, JSON.stringify(data))
    await fs.rename(tmp, file())
  } catch (err) {
    log.warn('persist failed:', String(err))
  }
}

// Debounced — the queue calls this on every state change.
let pending: QueueRecord[] | null = null
let timer: NodeJS.Timeout | null = null
export function schedulePersist(queued: QueueRecord[]): void {
  pending = queued
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    const q = pending
    pending = null
    if (q) void write(q)
  }, 250)
}

/** Write any pending debounced snapshot now (used on shutdown so queued jobs survive). */
export async function flushQueuePersist(): Promise<void> {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  const q = pending
  pending = null
  if (q) await write(q)
}

export async function loadQueue(): Promise<QueueRecord[]> {
  try {
    const raw = await fs.readFile(file(), 'utf8')
    const arr = JSON.parse(raw) as Partial<QueueRecord>[]
    return arr.map((r) => ({
      ...(r as QueueRecord),
      state: 'queued',
      noRetry: false,
      resolve: () => undefined,
    }))
  } catch {
    return []
  }
}
