import { renderAndPrint } from './render'
import type { PrintContext } from '../driver'

/**
 * Load a remote web page in a hidden window and print it silently. Unlike an
 * `html` job (inline markup), this loads the real URL so its own CSS, fonts,
 * images and scripts resolve from the page's origin.
 */
export async function printWebsite(ctx: PrintContext): Promise<void> {
  const url = ctx.job.source.url
  if (!url) throw new Error('website job requires a source.url')
  if (!/^https?:\/\//i.test(url)) throw new Error('website url must be http(s)')

  ctx.log.info(`printing website ${url} -> ${ctx.printerName ?? '(default)'}`)
  await renderAndPrint(async (win) => {
    await win.loadURL(url)
  }, ctx)
}
