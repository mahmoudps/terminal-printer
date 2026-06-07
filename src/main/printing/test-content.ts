import { BrowserWindow } from 'electron'
import { PROTOCOL_VERSION } from '@shared/constants'
import type { JobResult, JobType, PrintJob } from '@shared/types'
import type { PrintEngine } from './index'

const TEST_HTML = `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><style>
  body{font-family:'Segoe UI',Tahoma,sans-serif;margin:24px;color:#111}
  h1{font-size:22px;margin:0 0 8px}
  .row{display:flex;justify-content:space-between;border-bottom:1px dashed #999;padding:6px 0}
  .muted{color:#666;font-size:12px}
</style></head><body>
  <h1>Terminal Printer — اختبار الطباعة</h1>
  <p class="muted">Test print / طباعة تجريبية</p>
  <div class="row"><span>Receipt #</span><span>TP-0001</span></div>
  <div class="row"><span>المبلغ</span><span>1,250.00</span></div>
  <div class="row"><span>التاريخ</span><span>2026-05-30</span></div>
  <p class="muted">If you can read this clearly, printing works.</p>
</body></html>`

const TEST_RECEIPT_TEXT = [
  '     TERMINAL PRINTER',
  '     Test Receipt',
  '--------------------------------',
  'Item            Qty      Price',
  'Coffee           2       10.00',
  'Water            1        2.00',
  '--------------------------------',
  'TOTAL                    12.00',
  '',
  'Thank you!',
  '',
].join('\n')

// ZPL label: a box with "TEST".
const TEST_ZPL = '^XA^CF0,60^FO50,50^FDTEST LABEL^FS^FO50,130^GB300,3,3^FS^XZ'

/** Build and enqueue a built-in test job for the given format (mapped/default printer). */
export async function runTestPrint(engine: PrintEngine, type: JobType): Promise<JobResult> {
  return runTestPrintTo(engine, type, null)
}

/** Build and enqueue a built-in test job, optionally targeting a specific printer. */
export async function runTestPrintTo(
  engine: PrintEngine,
  type: JobType,
  printerName: string | null,
): Promise<JobResult> {
  const payload: { pdf?: string; image?: string } = {}
  if (type === 'pdf') payload.pdf = (await buildTestPdf()).toString('base64')
  if (type === 'image') payload.image = (await buildTestImage()).toString('base64')
  const job = buildTestJob(type, payload)
  if (printerName) job.printer = { ...(job.printer ?? {}), name: printerName }
  return engine.enqueue(job, 'test')
}

export function buildTestJob(type: JobType, payload: { pdf?: string; image?: string }): PrintJob {
  const base = { v: PROTOCOL_VERSION, id: `test-${type}-${Date.now()}` }
  switch (type) {
    case 'pdf':
      return { ...base, type, source: { base64: payload.pdf ?? '' }, options: { paperSize: 'A5', scale: 'noscale' } }
    case 'html':
      return { ...base, type, source: { text: TEST_HTML }, options: { paperSize: 'A5' } }
    case 'image':
      return { ...base, type, source: { base64: payload.image ?? '' }, options: { paperSize: 'A5' } }
    case 'escpos':
      return { ...base, type, source: { text: TEST_RECEIPT_TEXT }, options: { paperSize: '80mm', cut: true } }
    case 'raw':
      return { ...base, type, source: { text: TEST_ZPL } }
    default:
      throw new Error(`no built-in test for ${type}`)
  }
}

/** Render the test page to a PDF (exercises the real pdf-to-printer path). */
export async function buildTestPdf(): Promise<Buffer> {
  return withHiddenWindow(async (win) => {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(TEST_HTML))
    await waitForFonts(win)
    return win.webContents.printToPDF({ pageSize: 'A5', printBackground: true })
  })
}

/** Capture the test page as a PNG (exercises the image driver). */
export async function buildTestImage(): Promise<Buffer> {
  return withHiddenWindow(async (win) => {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(TEST_HTML))
    await waitForFonts(win)
    const image = await win.webContents.capturePage()
    return image.toPNG()
  })
}

async function withHiddenWindow<T>(fn: (win: BrowserWindow) => Promise<T>): Promise<T> {
  const win = new BrowserWindow({
    show: false,
    width: 600,
    height: 800,
    webPreferences: { offscreen: false, sandbox: true, contextIsolation: true },
  })
  try {
    return await fn(win)
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

function waitForFonts(win: BrowserWindow): Promise<void> {
  return win.webContents
    .executeJavaScript('document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true')
    .then(() => undefined)
    .catch(() => undefined)
}
