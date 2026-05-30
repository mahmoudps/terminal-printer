import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** Directory for transient print spool files. */
function spoolDir(): string {
  // app.getPath('temp') is per-user; fall back to os.tmpdir if app not ready.
  try {
    return app.getPath('temp')
  } catch {
    return tmpdir()
  }
}

/** Write bytes to a unique temp file and return its absolute path. */
export async function writeTempFile(data: Buffer, ext: string): Promise<string> {
  const name = `tp-${randomUUID()}${ext.startsWith('.') ? ext : '.' + ext}`
  const file = join(spoolDir(), name)
  await fs.writeFile(file, data)
  return file
}

/** Best-effort delete; never throws. */
export async function removeQuietly(file: string | undefined): Promise<void> {
  if (!file) return
  try {
    await fs.unlink(file)
  } catch {
    /* ignore */
  }
}

/** Path inside userData (config, certs, outbox). */
export function userDataFile(...parts: string[]): string {
  return join(app.getPath('userData'), ...parts)
}
