import { printHtml } from './html'
import type { PrintContext } from '../driver'

/**
 * Print an image (PNG/JPG/GIF) by wrapping it in a paper-sized HTML page and
 * routing through the HTML driver — gives exact fit + margins on laser/inkjet.
 * For thermal raster printing, use an `escpos` job with `data.image` instead.
 */
export async function printImage(ctx: PrintContext): Promise<void> {
  const { job, source } = ctx
  if (!source.buffer) throw new Error('image job requires a url or base64 source')
  const o = job.options ?? {}
  const mime = sniffMime(source.buffer)
  const b64 = source.buffer.toString('base64')

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: ${o.paperSize ?? 'A4'} ${o.orientation ?? 'portrait'}; margin: 0; }
html,body{margin:0;padding:0;height:100%;}
img{display:block;width:100%;height:100%;object-fit:contain;}
</style></head><body><img src="data:${mime};base64,${b64}"></body></html>`

  await printHtml({ ...ctx, source: { text: html } })
}

function sniffMime(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0x89 && buf[1] === 0x50) return 'image/png'
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif'
  if (buf.length >= 12 && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return 'image/png'
}
