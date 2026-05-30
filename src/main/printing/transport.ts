import type { PrintJob } from '@shared/types'
import type { Logger } from '../util/log'
import { sendTcp } from './net'
import { rawSpool } from './raw-spool'
import { lpPrintRaw } from './unix/lp'

/**
 * Send raw bytes to a printer, choosing the transport from the job:
 *  - network -> TCP socket (thermal printers on 9100), all platforms
 *  - queue (default) -> Windows RAW spool (winspool) or CUPS `lp -o raw` on mac/linux
 */
export async function transportRaw(
  job: PrintJob,
  printerName: string | null,
  bytes: Buffer,
  log: Logger,
): Promise<void> {
  if (job.printer?.transport === 'network') {
    if (!job.printer.host) throw new Error('network transport requires printer.host')
    await sendTcp(job.printer.host, job.printer.port ?? 9100, bytes)
    return
  }
  if (!printerName) {
    // CUPS can target the default destination with no `-d`; winspool needs a name.
    if (process.platform === 'win32') {
      throw new Error('no printer selected and no default available for raw printing — set a default printer in Settings')
    }
    await lpPrintRaw(null, bytes)
    return
  }
  if (process.platform === 'win32') await rawSpool(printerName, bytes, log)
  else await lpPrintRaw(printerName, bytes)
}
