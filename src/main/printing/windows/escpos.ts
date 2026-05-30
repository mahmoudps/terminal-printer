import ntp from 'node-thermal-printer'
import { transportRaw } from '../transport'
import type { PrintContext } from '../driver'

// node-thermal-printer ships CommonJS: { printer, types, characterSet, breakLine }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const NTP = ntp as any
const ThermalPrinter = NTP.printer
const PrinterTypes = NTP.types
const CharacterSet = NTP.characterSet

interface ReceiptLine {
  text?: string
  align?: 'left' | 'center' | 'right'
  bold?: boolean
  size?: number
  underline?: boolean
}
interface ReceiptModel {
  lines?: ReceiptLine[]
  qr?: string
  barcode?: string
  /** base64 PNG to raster (pixel-perfect Arabic). */
  image?: string
}

/**
 * Thermal ESC/POS printing. Three input modes:
 *  - source.base64  -> already-encoded ESC/POS bytes, sent as-is (passthrough)
 *  - job.data       -> structured receipt model (lines/qr/barcode/image)
 *  - source.text    -> plain text, one printed line per input line
 * Transport: network (TCP 9100) or RAW spool to a Windows queue.
 */
export async function printEscpos(ctx: PrintContext): Promise<void> {
  const { job, printerName, source, log } = ctx
  const o = job.options ?? {}

  // Passthrough: caller already produced ESC/POS bytes.
  if (source.buffer && job.data == null) {
    log.info(`escpos passthrough ${source.buffer.length} bytes`)
    await transportRaw(job, printerName, source.buffer, log)
    return
  }

  const width = o.width ?? (o.paperSize === '58mm' ? 32 : 48)
  const csName = (o.characterSet as string) || 'PC864_ARABIC'
  const tp = new ThermalPrinter({
    type: PrinterTypes.EPSON,
    // Placeholder interface — we never call execute(); we transport getBuffer() ourselves.
    interface: 'tcp://127.0.0.1:9100',
    width,
    characterSet: CharacterSet[csName] ?? CharacterSet.PC864_ARABIC,
    removeSpecialCharacters: false,
    options: { timeout: 5000 },
  })

  const data = job.data as ReceiptModel | undefined

  if (data?.image) {
    await tp.printImageBuffer(Buffer.from(data.image, 'base64'))
  } else if (data?.lines?.length) {
    for (const line of data.lines) renderLine(tp, line)
    if (data.qr) tp.printQR(data.qr)
    if (data.barcode) tp.printBarcode(data.barcode)
  } else if (source.text != null) {
    for (const l of source.text.split(/\r?\n/)) tp.println(l)
  } else {
    throw new Error('escpos job needs source.base64, source.text, or data')
  }

  if (o.openCashDrawer) tp.openCashDrawer()
  if (o.cut !== false) tp.cut()

  const bytes: Buffer = tp.getBuffer()
  log.info(`escpos rendered ${bytes.length} bytes (width=${width}, cs=${csName})`)
  await transportRaw(job, printerName, bytes, log)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderLine(tp: any, line: ReceiptLine): void {
  if (line.align === 'center') tp.alignCenter()
  else if (line.align === 'right') tp.alignRight()
  else tp.alignLeft()
  if (line.bold) tp.bold(true)
  if (line.underline) tp.underline(true)
  if (line.size && line.size >= 2) tp.setTextSize(1, 1)
  tp.println(line.text ?? '')
  tp.setTextNormal()
  tp.bold(false)
  tp.underline(false)
  tp.alignLeft()
}
