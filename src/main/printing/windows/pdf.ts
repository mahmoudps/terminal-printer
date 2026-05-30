import { print as sumatraPrint } from 'pdf-to-printer'
import { writeTempFile } from '../../util/paths'
import { lpPrintFile } from '../unix/lp'
import type { PrintContext } from '../driver'

/**
 * Silent PDF printing.
 *  - Windows: pdf-to-printer (bundled SumatraPDF); `scale: 'noscale'` keeps exact A4/A5.
 *  - macOS/Linux: CUPS `lp`.
 */
export async function printPdf(ctx: PrintContext): Promise<void> {
  const { job, printerName, source, log } = ctx
  if (!source.buffer) throw new Error('pdf job requires a url or base64 source')

  const file = await writeTempFile(source.buffer, '.pdf')
  ctx.cleanup.push(file)
  log.info(`printing PDF -> ${printerName ?? '(default)'} (copies=${job.copies ?? 1})`)

  if (process.platform !== 'win32') {
    await lpPrintFile(printerName, file, { copies: job.copies })
    return
  }

  const o = job.options ?? {}
  const options: Record<string, unknown> = {}
  if (printerName) options.printer = printerName
  if (job.copies && job.copies > 1) options.copies = job.copies
  options.scale = typeof o.scale === 'string' ? o.scale : 'noscale'
  if (o.orientation) options.orientation = o.orientation
  if (o.paperSize) options.paperSize = o.paperSize
  if (o.monochrome) options.monochrome = true
  if (o.duplex) options.side = 'duplex'
  await sumatraPrint(file, options)
}
