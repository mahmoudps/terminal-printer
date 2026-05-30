import { BrowserWindow } from 'electron'
import type { PrinterInfo, PrintJob, AgentSettings } from '@shared/types'

let enumWin: BrowserWindow | null = null

/** A persistent hidden window used solely to enumerate OS printers. */
function win(): BrowserWindow {
  if (!enumWin || enumWin.isDestroyed()) {
    enumWin = new BrowserWindow({
      show: false,
      skipTaskbar: true,
      webPreferences: { offscreen: false, nodeIntegration: false, contextIsolation: true },
    })
  }
  return enumWin
}

export async function listPrinters(): Promise<PrinterInfo[]> {
  const printers = await win().webContents.getPrintersAsync()
  return printers.map((p) => ({
    name: p.name,
    displayName: p.displayName || p.name,
    description: p.description,
    isDefault: p.isDefault,
    status: p.status,
  }))
}

export async function defaultPrinterName(): Promise<string | null> {
  const list = await listPrinters()
  return list.find((p) => p.isDefault)?.name ?? list[0]?.name ?? null
}

/**
 * Resolve the OS printer name for a job, in priority order:
 *  1. explicit job.printer.name
 *  2. settings.printerMap[meta.docType]
 *  3. settings.printerMap[job.type]
 *  4. settings.printerMap.default
 *  5. settings.defaultPrinter
 * Returns null when nothing matches (driver falls back to OS default).
 */
export function resolvePrinterName(job: PrintJob, settings: AgentSettings): string | null {
  if (job.printer?.name) return job.printer.name
  const map = settings.printerMap || {}
  const docType = job.meta?.docType
  if (docType && map[docType]) return map[docType]
  if (map[job.type]) return map[job.type]
  if (map.default) return map.default
  return settings.defaultPrinter
}

export function disposePrinterWindow(): void {
  if (enumWin && !enumWin.isDestroyed()) enumWin.destroy()
  enumWin = null
}
