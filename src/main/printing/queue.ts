import { EventEmitter } from 'node:events'
import { PROTOCOL_VERSION } from '@shared/constants'
import type { JobResult, PrintJob } from '@shared/types'
import type { QueueJobView, QueueSnapshot, QueueState } from '@shared/ipc'

export interface QueueConfig {
  maxConcurrent: number
  maxAttempts: number
  retryBackoffMs: number
  historyLimit: number
  persist: boolean
}

export interface QueueRecord {
  id: string
  type: string
  origin?: string
  printerKey: string
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
  job: PrintJob
  noRetry: boolean
  resolve: (r: JobResult) => void
}

export interface AddInput {
  job: PrintJob
  origin?: string
  printerName: string | null
  printerKey: string
}

/** A job runner — prints one job and resolves with a JobResult (never throws). */
export type Runner = (job: PrintJob, printerName: string | null) => Promise<JobResult>

/**
 * Observable print queue with bounded parallelism and per-printer isolation.
 *
 * - Up to `maxConcurrent` jobs print at once across all printers.
 * - At most one job per printer lane at a time (thermal/USB safety) — different
 *   printers therefore print in parallel, the same printer stays serial.
 * - Failed jobs retry up to `maxAttempts` with a backoff; queued jobs can be
 *   canceled; finished jobs roll into a capped history.
 * - Emits `update` on every state change.
 */
export class PrintQueue extends EventEmitter {
  private records = new Map<string, QueueRecord>()
  private order: string[] = [] // queued ids, FIFO
  private historyOrder: string[] = [] // terminal ids, FIFO (for trimming)
  private activeByPrinter = new Set<string>()
  private activeCount = 0

  constructor(
    private readonly cfg: () => QueueConfig,
    private readonly runner: Runner,
    private readonly persistFn?: (queued: QueueRecord[]) => void,
  ) {
    super()
  }

  add(input: AddInput): Promise<JobResult> {
    // Reject a duplicate id while it's still live — overwriting the record would
    // orphan the in-flight job's promise and hang whoever is awaiting it.
    const dup = this.records.get(input.job.id)
    if (dup) {
      if (dup.state === 'queued' || dup.state === 'printing') {
        return Promise.resolve({
          v: PROTOCOL_VERSION,
          id: input.job.id,
          status: 'failed',
          error: 'duplicate job id (already in queue)',
          ts: Date.now(),
        })
      }
      // A finished record with the same id: clear it so history stays consistent.
      this.removeFromHistory(input.job.id)
      this.records.delete(input.job.id)
    }
    const max = Math.max(1, this.cfg().maxAttempts)
    let resolveFn!: (r: JobResult) => void
    const promise = new Promise<JobResult>((resolve) => (resolveFn = resolve))
    const rec: QueueRecord = {
      id: input.job.id,
      type: input.job.type,
      origin: input.origin,
      printerKey: input.printerKey,
      printerName: input.printerName,
      state: 'queued',
      attempts: 0,
      maxAttempts: max,
      label: input.job.meta?.label,
      enqueuedAt: Date.now(),
      job: input.job,
      noRetry: false,
      resolve: resolveFn,
    }
    this.records.set(rec.id, rec)
    this.order.push(rec.id)
    this.changed()
    this.schedule()
    return promise
  }

  /** Re-add persisted jobs on launch (no caller awaits these). */
  restore(saved: QueueRecord[]): void {
    for (const r of saved) {
      if (this.records.has(r.id)) continue // don't collide with a live job
      const rec: QueueRecord = { ...r, state: 'queued', noRetry: false, resolve: () => undefined }
      this.records.set(rec.id, rec)
      this.order.push(rec.id)
    }
    if (saved.length) {
      this.changed()
      this.schedule()
    }
  }

  cancel(id: string): void {
    const rec = this.records.get(id)
    if (!rec) return
    if (rec.state === 'queued') {
      this.removeFromOrder(id)
      rec.state = 'canceled'
      rec.finishedAt = Date.now()
      rec.resolve({ v: PROTOCOL_VERSION, id, status: 'failed', error: 'canceled', ts: Date.now() })
      this.toHistory(rec)
      this.changed()
    } else if (rec.state === 'printing') {
      rec.noRetry = true // can't abort mid-spool; just prevent a retry
    }
  }

  retry(id: string): void {
    const rec = this.records.get(id)
    if (!rec || (rec.state !== 'failed' && rec.state !== 'canceled')) return
    this.removeFromHistory(id)
    rec.state = 'queued'
    rec.attempts = 0
    rec.error = undefined
    rec.noRetry = false
    rec.startedAt = rec.finishedAt = rec.durationMs = undefined
    rec.enqueuedAt = Date.now()
    rec.resolve = () => undefined
    this.order.push(id)
    this.changed()
    this.schedule()
  }

  clearHistory(): void {
    for (const id of this.historyOrder) this.records.delete(id)
    this.historyOrder = []
    this.changed()
  }

  snapshot(): QueueSnapshot {
    const active: QueueJobView[] = []
    const queued: QueueJobView[] = []
    for (const rec of this.records.values()) {
      if (rec.state === 'printing') active.push(view(rec))
      else if (rec.state === 'queued') queued.push(view(rec))
    }
    queued.sort((a, b) => a.enqueuedAt - b.enqueuedAt)
    const history = this.historyOrder
      .map((id) => this.records.get(id))
      .filter((r): r is QueueRecord => !!r)
      .map(view)
      .reverse() // newest first
    return { active, queued, history, activeCount: active.length, queuedCount: queued.length }
  }

  /** Re-evaluate scheduling (e.g. after maxConcurrent changed). */
  kick(): void {
    this.schedule()
  }

  counts(): { active: number; queued: number } {
    let active = 0
    let queued = 0
    for (const rec of this.records.values()) {
      if (rec.state === 'printing') active++
      else if (rec.state === 'queued') queued++
    }
    return { active, queued }
  }

  /* ------------------------------------------------------------------ */

  private schedule(): void {
    const { maxConcurrent } = this.cfg()
    for (const id of [...this.order]) {
      if (this.activeCount >= Math.max(1, maxConcurrent)) break
      const rec = this.records.get(id)
      if (!rec || rec.state !== 'queued') {
        this.removeFromOrder(id)
        continue
      }
      if (this.activeByPrinter.has(rec.printerKey)) continue // lane busy → try the next
      this.removeFromOrder(id)
      void this.runOne(rec)
    }
  }

  private async runOne(rec: QueueRecord): Promise<void> {
    rec.state = 'printing'
    rec.startedAt = Date.now()
    rec.attempts++
    this.activeByPrinter.add(rec.printerKey)
    this.activeCount++
    this.changed()

    let result: JobResult
    try {
      result = await this.runner(rec.job, rec.printerName)
    } catch (err) {
      result = {
        v: PROTOCOL_VERSION,
        id: rec.id,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
        ts: Date.now(),
      }
    }

    this.activeByPrinter.delete(rec.printerKey)
    this.activeCount--

    if (result.status === 'failed' && !rec.noRetry && rec.attempts < rec.maxAttempts) {
      rec.state = 'queued'
      rec.error = result.error
      rec.startedAt = undefined
      this.order.push(rec.id)
      this.changed()
      setTimeout(() => this.schedule(), Math.max(0, this.cfg().retryBackoffMs))
    } else {
      rec.state = result.status === 'printed' ? 'done' : 'failed'
      rec.error = result.error
      rec.finishedAt = Date.now()
      rec.durationMs = rec.startedAt ? rec.finishedAt - rec.startedAt : result.durationMs
      rec.resolve(result)
      this.toHistory(rec)
      this.changed()
    }
    this.schedule()
  }

  private toHistory(rec: QueueRecord): void {
    this.historyOrder.push(rec.id)
    const limit = Math.max(0, this.cfg().historyLimit)
    while (this.historyOrder.length > limit) {
      const old = this.historyOrder.shift()
      if (old) this.records.delete(old)
    }
  }

  private removeFromOrder(id: string): void {
    const i = this.order.indexOf(id)
    if (i >= 0) this.order.splice(i, 1)
  }

  private removeFromHistory(id: string): void {
    const i = this.historyOrder.indexOf(id)
    if (i >= 0) this.historyOrder.splice(i, 1)
  }

  private changed(): void {
    this.emit('update')
    if (this.cfg().persist && this.persistFn) {
      const queued = this.order
        .map((id) => this.records.get(id))
        .filter((r): r is QueueRecord => !!r && r.state === 'queued')
      this.persistFn(queued)
    }
  }
}

function view(rec: QueueRecord): QueueJobView {
  return {
    id: rec.id,
    type: rec.type,
    origin: rec.origin,
    printerName: rec.printerName,
    state: rec.state,
    attempts: rec.attempts,
    maxAttempts: rec.maxAttempts,
    error: rec.error,
    label: rec.label,
    enqueuedAt: rec.enqueuedAt,
    startedAt: rec.startedAt,
    finishedAt: rec.finishedAt,
    durationMs: rec.durationMs,
  }
}
