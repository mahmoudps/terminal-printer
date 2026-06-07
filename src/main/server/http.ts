import http from 'node:http'
import { app } from 'electron'
import { PROTOCOL_VERSION } from '@shared/constants'
import { parsePrintJob } from '@shared/schema'
import { scoped } from '../util/log'
import { authorizeJob } from '../security/authorize'
import type { ServerDeps } from './deps'

const log = scoped('http')
const MAX_BODY = 30 * 1024 * 1024 // 30 MB

export function createHttpServer(deps: ServerDeps): http.Server {
  return http.createServer((req, res) => {
    handle(req, res, deps).catch((err) => {
      log.error('handler error', err)
      sendJson(res, 500, { error: 'internal error' })
    })
  })
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, deps: ServerDeps): Promise<void> {
  setCors(req, res)
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname
  const origin = req.headers.origin

  if (req.method === 'GET' && path === '/health') {
    const s = deps.store.get()
    sendJson(res, 200, {
      ok: true,
      name: app.getName(),
      version: app.getVersion(),
      protocol: PROTOCOL_VERSION,
      agentId: s.agentId,
      paired: !!deps.registry.tokenFor(origin),
      paused: s.paused,
      stats: deps.engine.getStats(),
    })
    return
  }

  // Loopback-only, read-only self-diagnosis (used by the CLI `doctor`).
  if (req.method === 'GET' && path === '/diagnostics') {
    if (!deps.getDiagnostics) {
      sendJson(res, 503, { error: 'diagnostics unavailable' })
      return
    }
    sendJson(res, 200, await deps.getDiagnostics())
    return
  }

  // Auto-approve registration for HTTP-only clients (returns the site token).
  if (req.method === 'POST' && path === '/pair') {
    const record = deps.registry.ensure(origin)
    if (!record) {
      sendJson(res, 403, { error: 'site is blocked' })
      return
    }
    sendJson(res, 200, { token: record.token, agentId: deps.store.get().agentId })
    return
  }

  if (req.method === 'GET' && path === '/printers') {
    const printers = await deps.engine.listPrinters()
    sendJson(res, 200, { printers })
    return
  }

  if (req.method === 'POST' && path === '/print') {
    const body = await readJson(req)
    const parsed = parsePrintJob(body?.job ?? body)
    if (!parsed.ok) {
      sendJson(res, 400, { error: parsed.error })
      return
    }
    const auth = authorizeJob(parsed.job, origin, deps.registry, deps.nonces)
    if (!auth.ok) {
      sendJson(res, auth.reason === 'unpaired' ? 401 : 403, { error: auth.error, reason: auth.reason })
      return
    }
    const result = await deps.engine.enqueue(parsed.job, origin)
    sendJson(res, result.status === 'printed' ? 200 : 502, result)
    return
  }

  sendJson(res, 404, { error: 'not found' })
}

function setCors(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = req.headers.origin
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  // Chrome Private Network Access: allow public HTTPS pages to reach loopback.
  res.setHeader('Access-Control-Allow-Private-Network', 'true')
}

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve(undefined)
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid json'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  // The error path can reach here after the socket was destroyed (e.g. an
  // oversized body); writing then throws. Bail if the response is already done.
  if (res.writableEnded || res.destroyed) return
  try {
    const payload = JSON.stringify(body)
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(payload)
  } catch {
    /* socket went away mid-write */
  }
}
