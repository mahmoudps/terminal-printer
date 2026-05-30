import { transportRaw } from '../transport'
import type { PrintContext } from '../driver'

/**
 * Raw passthrough — ZPL/EPL label languages or pre-encoded byte streams.
 * Text sources are treated as latin1 bytes (ZPL is ASCII).
 */
export async function printRaw(ctx: PrintContext): Promise<void> {
  const { job, printerName, source, log } = ctx
  const bytes =
    source.buffer ?? (source.text != null ? Buffer.from(source.text, 'latin1') : null)
  if (!bytes) throw new Error('raw job requires a base64 or text source')

  log.info(`raw print ${bytes.length} bytes -> ${printerName ?? job.printer?.host ?? '(?)'}`)
  await transportRaw(job, printerName, bytes, log)
}
