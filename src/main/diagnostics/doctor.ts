/**
 * Self-diagnosis ("doctor"): runs a battery of health checks and returns a
 * structured report for the GUI Diagnostics panel, the loopback /diagnostics
 * endpoint, and the CLI. Each check is pass / warn / fail with a remediation hint.
 */
import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import { PROTOCOL_VERSION } from '@shared/constants'
import type { PrinterInfo } from '@shared/types'
import type { DiagCheck, DiagReport } from '@shared/ipc'
import { userDataFile } from '../util/paths'
import { signJob, verifyJob, generateSecret } from '../security/hmac'

/** Everything the doctor needs, injected so it stays decoupled + testable. */
export interface DoctorInput {
  version: string
  serverRunning: boolean
  serverPort: number
  serverError?: string
  serverStopped?: boolean
  defaultPrinter: string | null
  cloudEnabled: boolean
  cloudState: string
  queued: number
  active: number
  listPrinters: () => Promise<PrinterInfo[]>
}

export async function runDoctor(input: DoctorInput): Promise<DiagReport> {
  const checks: DiagCheck[] = []

  // 1) Local server bound?
  if (input.serverRunning) {
    checks.push({ id: 'server', label: 'Local server', status: 'pass', detail: `Listening on 127.0.0.1:${input.serverPort}` })
  } else if (input.serverStopped) {
    checks.push({ id: 'server', label: 'Local server', status: 'warn', detail: 'Stopped by user', hint: 'Network → Start to resume serving.' })
  } else {
    checks.push({ id: 'server', label: 'Local server', status: 'fail', detail: input.serverError || 'Not running', hint: 'Change the port if it is in use, then Restart in Network.' })
  }

  // 2) Printers discoverable?
  let printers: PrinterInfo[] = []
  let printersErr: string | undefined
  try {
    printers = await input.listPrinters()
  } catch (e) {
    printersErr = e instanceof Error ? e.message : String(e)
  }
  if (printersErr) {
    checks.push({ id: 'printers', label: 'Printer enumeration', status: 'fail', detail: printersErr, hint: 'The OS print service may be down. Restart the spooler (Windows) or CUPS (mac/Linux).' })
  } else if (printers.length) {
    checks.push({ id: 'printers', label: 'Printers detected', status: 'pass', detail: `${printers.length} printer(s) available` })
  } else {
    checks.push({ id: 'printers', label: 'Printers detected', status: 'warn', detail: 'No printers found', hint: 'Add a printer, or use network transport (TCP 9100) for thermal devices.' })
  }

  // 3) A usable default target?
  const osDefault = printers.find((p) => p.isDefault)?.name
  if (input.defaultPrinter) {
    const exists = !printers.length || printers.some((p) => p.name === input.defaultPrinter)
    checks.push(
      exists
        ? { id: 'default', label: 'Default printer', status: 'pass', detail: `Agent default: ${input.defaultPrinter}` }
        : { id: 'default', label: 'Default printer', status: 'warn', detail: `"${input.defaultPrinter}" not found among installed printers`, hint: 'Pick an available printer in Printers.' },
    )
  } else if (osDefault) {
    checks.push({ id: 'default', label: 'Default printer', status: 'pass', detail: `Using OS default: ${osDefault}` })
  } else {
    checks.push({ id: 'default', label: 'Default printer', status: 'warn', detail: 'No default set', hint: 'Set one in Printers so jobs without an explicit printer have a target.' })
  }

  // 4) Platform print backend present?
  if (process.platform === 'win32') {
    checks.push({ id: 'backend', label: 'Print backend', status: 'pass', detail: 'Windows winspool + bundled SumatraPDF' })
  } else {
    const [lp, lpstat] = await Promise.all([which('lp'), which('lpstat')])
    checks.push(
      lp && lpstat
        ? { id: 'backend', label: 'Print backend (CUPS)', status: 'pass', detail: 'lp + lpstat found on PATH' }
        : { id: 'backend', label: 'Print backend (CUPS)', status: 'fail', detail: 'lp/lpstat not found', hint: 'Install the CUPS client (e.g. `cups-client`) so the agent can print.' },
    )
  }

  // 5) Job signing round-trips (HMAC parity with the SDK)?
  try {
    const secret = generateSecret()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const job: any = { v: PROTOCOL_VERSION, id: 'diag', type: 'pdf', source: { url: 'https://example.com/x.pdf' }, ts: Date.now(), nonce: 'diag-nonce' }
    job.signature = signJob(job, secret)
    checks.push({ id: 'hmac', label: 'Job signing (HMAC)', status: verifyJob(job, secret) ? 'pass' : 'fail', detail: 'sign / verify round-trip' })
  } catch (e) {
    checks.push({ id: 'hmac', label: 'Job signing (HMAC)', status: 'fail', detail: e instanceof Error ? e.message : String(e) })
  }

  // 6) Config / state storage writable?
  checks.push(await writableCheck())

  // 7) Cloud relay (only if enabled).
  if (!input.cloudEnabled) {
    checks.push({ id: 'cloud', label: 'Cloud relay', status: 'pass', detail: 'Disabled (local-only)' })
  } else if (input.cloudState === 'connected') {
    checks.push({ id: 'cloud', label: 'Cloud relay', status: 'pass', detail: 'Connected' })
  } else {
    checks.push({ id: 'cloud', label: 'Cloud relay', status: 'warn', detail: `State: ${input.cloudState}`, hint: 'Verify the server URL, token, and Reverb settings in Cloud.' })
  }

  // 8) Queue health.
  if (input.queued > 50) {
    checks.push({ id: 'queue', label: 'Queue backlog', status: 'warn', detail: `${input.queued} job(s) queued`, hint: 'Raise max parallel jobs, or check for a stuck/offline printer.' })
  } else {
    checks.push({ id: 'queue', label: 'Queue', status: 'pass', detail: `${input.active} active, ${input.queued} queued` })
  }

  const summary = {
    pass: checks.filter((c) => c.status === 'pass').length,
    warn: checks.filter((c) => c.status === 'warn').length,
    fail: checks.filter((c) => c.status === 'fail').length,
  }
  return {
    generatedAt: Date.now(),
    version: input.version,
    platform: process.platform,
    arch: process.arch,
    summary,
    checks,
    printers,
    defaultPrinter: input.defaultPrinter,
  }
}

/** Is a command on PATH? (`where` on Windows, `which` elsewhere.) */
function which(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const p = spawn(process.platform === 'win32' ? 'where' : 'which', [cmd])
      p.on('error', () => resolve(false))
      p.on('close', (code) => resolve(code === 0))
    } catch {
      resolve(false)
    }
  })
}

async function writableCheck(): Promise<DiagCheck> {
  try {
    const f = userDataFile('.diag-write-test')
    await fs.writeFile(f, 'ok')
    await fs.unlink(f)
    return { id: 'storage', label: 'Config storage', status: 'pass', detail: 'App data folder is writable' }
  } catch (e) {
    return { id: 'storage', label: 'Config storage', status: 'fail', detail: e instanceof Error ? e.message : String(e), hint: 'Check permissions on the app data folder.' }
  }
}
