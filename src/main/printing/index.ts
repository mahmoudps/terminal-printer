import type { AgentSettings, JobResult, JobType, PrintJob, PrinterInfo, WebsiteJob } from '@shared/types'
import type { HealthStats, QueueSnapshot } from '@shared/ipc'
import { PROTOCOL_VERSION } from '@shared/constants'
import { scoped } from '../util/log'
import { removeQuietly } from '../util/paths'
import type { PrintContext, PrintDriver } from './driver'
import { listPrinters, resolvePrinterName } from './printers'
import { loadSource } from './resolve-source'
import { PrintQueue, type QueueConfig, type QueueRecord } from './queue'
import { printPdf } from './windows/pdf'
import { printEscpos } from './windows/escpos'
import { printImage } from './windows/image'
import { printHtml } from './windows/html'
import { printWebsite } from './windows/website'
import { printRaw } from './windows/raw'

const log = scoped('print')

const drivers: Record<JobType, PrintDriver> = {
  pdf: printPdf,
  escpos: printEscpos,
  image: printImage,
  html: printHtml,
  website: printWebsite,
  raw: printRaw,
}

/**
 * Validates + routes jobs to drivers via an observable, bounded-parallel queue.
 * `enqueue()` returns a promise that settles when the job reaches a terminal
 * state (preserving the WS/HTTP ack→result contract).
 */
export class PrintEngine {
  readonly queue: PrintQueue
  /** Called when a job reaches a terminal state, for per-website history. */
  onJobDone?: (origin: string | undefined, job: WebsiteJob) => void

  /** Lifetime counters for the Health card / diagnostics. */
  private readonly stats = {
    startedAt: Date.now(),
    total: 0,
    printed: 0,
    failed: 0,
    lastError: undefined as string | undefined,
    lastJobAt: undefined as number | undefined,
  }

  getStats(): HealthStats {
    const counts = this.queue.counts()
    const total = this.stats.total
    return {
      uptimeMs: Date.now() - this.stats.startedAt,
      total,
      printed: this.stats.printed,
      failed: this.stats.failed,
      successRate: total ? this.stats.printed / total : 1,
      queuedNow: counts.queued,
      activeNow: counts.active,
      lastError: this.stats.lastError,
      lastJobAt: this.stats.lastJobAt,
    }
  }

  constructor(
    private readonly getSettings: () => AgentSettings,
    persistFn?: (queued: QueueRecord[]) => void,
  ) {
    this.queue = new PrintQueue(
      () => this.queueConfig(),
      (job, printerName) => this.execute(job, printerName),
      persistFn,
    )
  }

  private queueConfig(): QueueConfig {
    const s = this.getSettings()
    return {
      maxConcurrent: s.maxConcurrent ?? 3,
      maxAttempts: s.maxAttempts ?? 1,
      retryBackoffMs: s.retryBackoffMs ?? 3000,
      historyLimit: s.historyLimit ?? 100,
      persist: s.persistQueue ?? true,
    }
  }

  listPrinters(): Promise<PrinterInfo[]> {
    return listPrinters()
  }

  /** Add a job (or fan it out to multiple printers). Resolves at terminal state. */
  enqueue(job: PrintJob, origin?: string): Promise<JobResult> {
    const settings = this.getSettings()
    if (settings.paused) return Promise.resolve(this.fail(job, 'agent is paused'))

    if (job.printers && job.printers.length) {
      const children = job.printers.map((name, i) =>
        this.enqueueSingle(
          { ...job, id: `${job.id}#${i + 1}`, printer: { ...(job.printer ?? {}), name }, printers: undefined },
          origin,
        ),
      )
      return Promise.all(children).then((results) => this.aggregate(job.id, results))
    }
    return this.enqueueSingle(job, origin)
  }

  private enqueueSingle(job: PrintJob, origin?: string): Promise<JobResult> {
    const settings = this.getSettings()
    const printerName = resolvePrinterName(job, settings)
    const printerKey =
      printerName ??
      (job.printer?.host ? `net:${job.printer.host}:${job.printer.port ?? 9100}` : 'os-default')
    const promise = this.queue.add({ job, origin, printerName, printerKey })
    void promise.then((result) => {
      this.stats.total++
      if (result.status === 'printed') this.stats.printed++
      else {
        this.stats.failed++
        this.stats.lastError = result.error
      }
      this.stats.lastJobAt = Date.now()
    })
    if (this.onJobDone) {
      void promise.then((result) =>
        this.onJobDone?.(origin, {
          id: job.id,
          type: job.type,
          label: typeof job.meta?.label === 'string' ? job.meta.label : undefined,
          printer: printerName,
          status: result.status === 'printed' ? 'printed' : 'failed',
          error: result.error,
          durationMs: result.durationMs,
          at: Date.now(),
        }),
      )
    }
    return promise
  }

  /** Run one job through its driver. Never throws — returns a JobResult. */
  async execute(job: PrintJob, printerName: string | null): Promise<JobResult> {
    const settings = this.getSettings()
    const startedAt = Date.now()
    const cleanup: string[] = []
    try {
      const driver = drivers[job.type]
      if (!driver) throw new Error(`unsupported job type: ${job.type}`)
      // `website` loads its own URL in a window — no byte loading needed.
      const source = job.type === 'website' ? {} : await loadSource(job.source, { allowFile: settings.allowFileSource })
      const ctx: PrintContext = { job, printerName, source, log, cleanup }
      await driver(ctx)
      const durationMs = Date.now() - startedAt
      log.info(`job ${job.id} (${job.type}) printed in ${durationMs}ms`)
      return {
        v: PROTOCOL_VERSION,
        id: job.id,
        status: 'printed',
        printer: printerName ?? undefined,
        durationMs,
        ts: Date.now(),
      }
    } catch (err) {
      return this.fail(job, err instanceof Error ? err.message : String(err))
    } finally {
      for (const file of cleanup) await removeQuietly(file)
    }
  }

  // ── queue passthrough (used by IPC) ──
  snapshot(): QueueSnapshot {
    return this.queue.snapshot()
  }
  cancel(id: string): void {
    this.queue.cancel(id)
  }
  retry(id: string): void {
    this.queue.retry(id)
  }
  clearHistory(): void {
    this.queue.clearHistory()
  }
  restoreQueue(saved: QueueRecord[]): void {
    this.queue.restore(saved)
  }
  queueCounts(): { active: number; queued: number } {
    return this.queue.counts()
  }
  kick(): void {
    this.queue.kick()
  }

  private aggregate(id: string, results: JobResult[]): JobResult {
    const failed = results.filter((r) => r.status === 'failed')
    if (failed.length) {
      return {
        v: PROTOCOL_VERSION,
        id,
        status: 'failed',
        error: `${failed.length}/${results.length} failed: ${failed.map((f) => f.error).join('; ')}`,
        ts: Date.now(),
      }
    }
    return {
      v: PROTOCOL_VERSION,
      id,
      status: 'printed',
      durationMs: Math.max(0, ...results.map((r) => r.durationMs ?? 0)),
      ts: Date.now(),
    }
  }

  private fail(job: PrintJob, error: string): JobResult {
    log.error(`job ${job?.id} failed: ${error}`)
    return { v: PROTOCOL_VERSION, id: job.id, status: 'failed', error, ts: Date.now() }
  }
}

export type { QueueRecord }
