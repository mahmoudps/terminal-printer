import type { PrintJob } from '@shared/types'
import type { Logger } from '../util/log'

/** A source already loaded into memory (or kept as inline text). */
export interface LoadedSource {
  buffer?: Buffer
  text?: string
}

export interface PrintContext {
  job: PrintJob
  /** Resolved OS printer name, or null to let the driver use the OS default. */
  printerName: string | null
  source: LoadedSource
  log: Logger
  /** Temp files registered here are deleted by the dispatcher after printing. */
  cleanup: string[]
}

/** A driver prints one job; it throws on failure. */
export type PrintDriver = (ctx: PrintContext) => Promise<void>
