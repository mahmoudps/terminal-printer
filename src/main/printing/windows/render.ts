import { BrowserWindow } from 'electron'
import { printPdf } from './pdf'
import type { PrintContext } from '../driver'

/**
 * Shared hidden-window render + silent print, used by the `html` driver (data:
 * URL) and the `website` driver (remote URL). Content runs in a sandboxed
 * renderer process — isolated from the agent's main process.
 */
export async function renderAndPrint(
  load: (win: BrowserWindow) => Promise<void>,
  ctx: PrintContext,
): Promise<void> {
  const { job, printerName } = ctx
  const o = job.options ?? {}

  const win = new BrowserWindow({
    show: false,
    width: 1240,
    height: 1754,
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, offscreen: false },
  })

  try {
    await load(win)
    // Wait for web fonts so Arabic/Cairo render before we snapshot/print.
    await win.webContents
      .executeJavaScript('document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true')
      .catch(() => undefined)

    if (o.toPdfFirst) {
      const pdf = await win.webContents.printToPDF({
        pageSize: toPageSize(o.paperSize),
        landscape: o.orientation === 'landscape',
        printBackground: true,
        scale: typeof o.scale === 'number' ? o.scale : 1,
      })
      await printPdf({ ...ctx, source: { buffer: pdf } })
      return
    }

    await new Promise<void>((resolve, reject) => {
      win.webContents.print(
        {
          silent: true,
          deviceName: printerName ?? undefined,
          printBackground: true,
          copies: job.copies && job.copies > 0 ? job.copies : 1,
          landscape: o.orientation === 'landscape',
          pageSize: toPageSize(o.paperSize),
        },
        (success, failureReason) => (success ? resolve() : reject(new Error(failureReason || 'print() failed'))),
      )
    })
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toPageSize(paper?: string): any {
  if (!paper) return 'A4'
  const named = ['A3', 'A4', 'A5', 'Legal', 'Letter', 'Tabloid']
  if (named.includes(paper)) return paper
  const mm = /^(\d+)mm$/.exec(paper)
  if (mm) return { width: parseInt(mm[1], 10) * 1000, height: 297 * 1000 }
  return 'A4'
}
