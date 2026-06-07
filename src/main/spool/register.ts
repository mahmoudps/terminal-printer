import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { app } from 'electron'
import { scoped } from '../util/log'
import { listPrinters } from '../printing/printers'

const log = scoped('vprinter')

export const VIRTUAL_PRINTER_NAME_WIN = 'Terminal Printer (Virtual)'
export const VIRTUAL_PRINTER_NAME_UNIX = 'TerminalPrinter'

export interface RegisterResult {
  ok: boolean
  message: string
}

/** Where the OS-registration scripts live (bundled as extraResources when packaged). */
function scriptDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'virtual-printer')
    : join(app.getAppPath(), 'scripts', 'virtual-printer')
}

/** Is the virtual printer currently registered with the OS? */
export async function isVirtualPrinterInstalled(): Promise<boolean> {
  try {
    const list = await listPrinters()
    return list.some((p) => p.name === VIRTUAL_PRINTER_NAME_WIN || p.name === VIRTUAL_PRINTER_NAME_UNIX)
  } catch {
    return false
  }
}

export async function installVirtualPrinter(port: number): Promise<RegisterResult> {
  if (process.platform === 'win32') {
    try {
      await runElevatedPwsh(join(scriptDir(), 'windows-install.ps1'), port)
    } catch (e) {
      return { ok: false, message: `Install failed or was cancelled: ${String(e)}` }
    }
    const ok = await isVirtualPrinterInstalled()
    return {
      ok,
      message: ok
        ? 'Virtual printer installed — it now appears in your OS printer list.'
        : 'The installer ran; if no printer appeared, approve the elevation prompt and try again.',
    }
  }
  // macOS / Linux: GUI elevation isn't available — guide the user to run it with sudo.
  return {
    ok: false,
    message: `Run this once in a terminal:  sudo sh "${join(scriptDir(), 'unix-install.sh')}" ${port} ${VIRTUAL_PRINTER_NAME_UNIX}`,
  }
}

export async function removeVirtualPrinter(port: number): Promise<RegisterResult> {
  if (process.platform === 'win32') {
    try {
      await runElevatedPwsh(join(scriptDir(), 'windows-uninstall.ps1'), port)
    } catch (e) {
      return { ok: false, message: `Remove failed or was cancelled: ${String(e)}` }
    }
    const stillThere = await isVirtualPrinterInstalled()
    return {
      ok: !stillThere,
      message: stillThere ? 'The remover ran; approve the elevation prompt if needed.' : 'Virtual printer removed.',
    }
  }
  return {
    ok: false,
    message: `Run this in a terminal:  sudo sh "${join(scriptDir(), 'unix-uninstall.sh')}" ${VIRTUAL_PRINTER_NAME_UNIX}`,
  }
}

/** Run a PowerShell script elevated (UAC), waiting for it to finish. */
function runElevatedPwsh(scriptPath: string, port: number): Promise<void> {
  const safe = scriptPath.replace(/'/g, "''")
  const inner =
    `Start-Process powershell -Verb RunAs -Wait -ArgumentList ` +
    `@('-NoProfile','-ExecutionPolicy','Bypass','-File','${safe}','-Port','${port}')`
  log.info(`registering virtual printer via elevated script: ${scriptPath}`)
  return new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', inner], {
      windowsHide: true,
    })
    let err = ''
    p.stderr.on('data', (d) => (err += d.toString()))
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `exited ${code}`))))
  })
}
