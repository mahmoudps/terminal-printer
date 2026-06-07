#!/usr/bin/env node
/**
 * Terminal Printer CLI — read-only diagnostics over the agent's loopback HTTP API.
 *
 *   terminal-printer status     agent status + health summary (default)
 *   terminal-printer doctor     full self-diagnosis (exit 1 if any check fails)
 *   terminal-printer printers   list the OS printers the agent sees
 *   terminal-printer help
 *
 * No auth needed — these endpoints are read-only and bound to loopback only.
 * Override the host with TP_HOST and ports with TP_PORTS=9120,9121 if customised.
 */
import http from 'node:http'

const HOST = process.env.TP_HOST || '127.0.0.1'
const PORTS = (process.env.TP_PORTS || '9120,9121,9122').split(',').map((p) => parseInt(p.trim(), 10))

const TTY = process.stdout.isTTY
const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m' }
const paint = (code, s) => (TTY ? code + s + C.reset : String(s))

// One-shot request with no keep-alive (agent:false) so the socket closes and the
// CLI process can exit cleanly — global fetch (undici) keeps a pooled socket
// alive, which trips a libuv assertion on process.exit() on Windows.
function getJson(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: HOST, port, path, timeout: 4000, agent: false }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (data += c))
      res.on('end', () => {
        const ok = res.statusCode && res.statusCode >= 200 && res.statusCode < 300
        if (!ok) return reject(new Error(`${path} -> HTTP ${res.statusCode}`))
        try {
          resolve(JSON.parse(data))
        } catch (e) {
          reject(e)
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error('request timed out')))
    req.on('error', reject)
  })
}

async function findAgent() {
  for (const port of PORTS) {
    try {
      const health = await getJson(port, '/health')
      if (health && health.ok) return { port, health }
    } catch {
      /* try next port */
    }
  }
  return null
}

function fmtUptime(ms) {
  const s = Math.floor((ms || 0) / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}h ${m}m` : m ? `${m}m` : `${s}s`
}

function help() {
  console.log(`${paint(C.bold, 'Terminal Printer CLI')}

Usage: terminal-printer <command>

  status     Agent status + health summary (default)
  doctor     Full self-diagnosis — exits 1 if any check fails
  printers   List the OS printers the agent sees
  help       Show this help

Env: TP_HOST (default 127.0.0.1), TP_PORTS (default 9120,9121,9122)`)
}

async function main() {
  const cmd = (process.argv[2] || 'status').toLowerCase()
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    help()
    return 0
  }

  const found = await findAgent()
  if (!found) {
    console.error(paint(C.red, `Terminal Printer agent not found on ${HOST} (ports ${PORTS.join(', ')}).`))
    console.error(paint(C.dim, 'Is the agent running? Launch it, or check the configured port.'))
    return 2
  }
  const { port, health } = found

  if (cmd === 'status') {
    const s = health.stats || {}
    console.log(paint(C.bold, `${health.name} v${health.version}`) + paint(C.dim, `  ·  ${HOST}:${port}`))
    console.log(`  agent id   ${health.agentId}`)
    console.log(`  paused     ${health.paused ? paint(C.yellow, 'yes') : 'no'}`)
    if (s.uptimeMs != null) {
      console.log(`  uptime     ${fmtUptime(s.uptimeMs)}`)
      const failed = s.failed ? paint(C.red, `${s.failed} failed`) : '0 failed'
      console.log(`  jobs       ${s.total} total · ${paint(C.green, `${s.printed} printed`)} · ${failed}`)
      console.log(`  queue      ${s.activeNow} active · ${s.queuedNow} queued`)
    }
    return 0
  }

  if (cmd === 'printers') {
    const { printers } = await getJson(port, '/printers')
    if (!printers || !printers.length) {
      console.log('No printers found.')
      return 0
    }
    for (const p of printers) {
      const dot = p.isDefault ? paint(C.green, '● ') : '  '
      console.log(`${dot}${p.displayName || p.name}${p.isDefault ? paint(C.dim, '  (default)') : ''}`)
    }
    return 0
  }

  if (cmd === 'doctor') {
    const rep = await getJson(port, '/diagnostics')
    console.log(paint(C.bold, `Diagnostics — ${rep.platform}/${rep.arch} · v${rep.version}`))
    console.log('')
    for (const ch of rep.checks) {
      const mark = ch.status === 'pass' ? paint(C.green, '✓') : ch.status === 'warn' ? paint(C.yellow, '!') : paint(C.red, '✗')
      console.log(`${mark} ${ch.label.padEnd(26)} ${paint(C.dim, ch.detail)}`)
      if (ch.hint && ch.status !== 'pass') console.log(`    ${paint(C.dim, '↳ ' + ch.hint)}`)
    }
    console.log('')
    console.log(
      `${paint(C.green, rep.summary.pass + ' pass')} · ${paint(C.yellow, rep.summary.warn + ' warn')} · ${paint(C.red, rep.summary.fail + ' fail')}`,
    )
    return rep.summary.fail > 0 ? 1 : 0
  }

  console.error(`Unknown command: ${cmd} (try "terminal-printer help")`)
  return 2
}

main()
  .then((code) => process.exit(code || 0))
  .catch((err) => {
    console.error('CLI error:', err && err.message ? err.message : String(err))
    process.exit(2)
  })
