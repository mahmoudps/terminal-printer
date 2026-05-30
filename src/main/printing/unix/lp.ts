import { spawn } from 'node:child_process'
import { writeTempFile, removeQuietly } from '../../util/paths'

/**
 * macOS/Linux printing via CUPS `lp`. The Windows path uses SumatraPDF +
 * winspool instead; this module is only reached when process.platform !== 'win32'.
 */

/** Print a file (PDF, image, …) through CUPS. */
export async function lpPrintFile(
  printer: string | null,
  file: string,
  opts: { copies?: number; raw?: boolean } = {},
): Promise<void> {
  const args: string[] = []
  if (printer) args.push('-d', printer)
  if (opts.copies && opts.copies > 1) args.push('-n', String(opts.copies))
  if (opts.raw) args.push('-o', 'raw')
  args.push(file)
  await runLp(args)
}

/** Send raw bytes (ESC/POS, ZPL) straight to a CUPS queue. */
export async function lpPrintRaw(printer: string | null, data: Buffer): Promise<void> {
  const file = await writeTempFile(data, '.bin')
  try {
    const args: string[] = []
    if (printer) args.push('-d', printer)
    args.push('-o', 'raw', file)
    await runLp(args)
  } finally {
    await removeQuietly(file)
  }
}

function runLp(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('lp', args)
    let stderr = ''
    p.stderr.on('data', (d) => (stderr += d.toString()))
    p.on('error', reject)
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`lp exited ${code}: ${stderr.trim()}`)),
    )
  })
}
