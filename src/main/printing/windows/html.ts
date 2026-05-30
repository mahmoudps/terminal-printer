import { renderAndPrint } from './render'
import type { PrintContext } from '../driver'

/**
 * Render an HTML snippet in a hidden window and print it silently. Chromium
 * shapes RTL Arabic natively (pass <html dir="rtl" lang="ar">).
 * `options.toPdfFirst` renders to a PDF then prints via SumatraPDF for exact
 * paper metrics and reliable copy fan-out.
 */
export async function printHtml(ctx: PrintContext): Promise<void> {
  const { source, printerName, log } = ctx
  const html = source.text ?? (source.buffer ? source.buffer.toString('utf8') : null)
  if (html == null) throw new Error('html job requires a text, url, or base64 source')

  log.info(`printing HTML -> ${printerName ?? '(default)'}`)
  await renderAndPrint(
    (win) => win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)),
    ctx,
  )
}
