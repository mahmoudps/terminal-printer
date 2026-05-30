import type http from 'node:http'
import { app } from 'electron'
import { WebSocketServer, type WebSocket } from 'ws'
import { PROTOCOL_VERSION, WS_PATH } from '@shared/constants'
import { parsePrintJob } from '@shared/schema'
import type { ClientMessage, ServerMessage } from '@shared/types'
import { scoped } from '../util/log'
import { authorizeJob } from '../security/authorize'
import type { ServerDeps } from './deps'

const log = scoped('ws')

export function attachWebSocket(server: http.Server, deps: ServerDeps): WebSocketServer {
  const wss = new WebSocketServer({ server, path: WS_PATH, maxPayload: 30 * 1024 * 1024 })
  wss.on('connection', (ws, req) => {
    const origin = req.headers.origin
    log.info('connection from', origin ?? '(no origin)')
    deps.registry.markConnected(origin)
    ws.on('close', () => deps.registry.markDisconnected(origin))
    send(ws, {
      kind: 'hello',
      name: app.getName(),
      version: app.getVersion(),
      protocol: PROTOCOL_VERSION,
      paired: !!deps.registry.tokenFor(origin),
    })

    ws.on('message', (raw) => {
      let msg: ClientMessage
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return send(ws, { kind: 'error', error: 'invalid json' })
      }
      handle(ws, origin, msg, deps).catch((err) => {
        log.error('handler error', err)
        send(ws, { kind: 'error', error: 'internal error' })
      })
    })
  })
  return wss
}

async function handle(
  ws: WebSocket,
  origin: string | undefined,
  msg: ClientMessage,
  deps: ServerDeps,
): Promise<void> {
  switch (msg.kind) {
    case 'ping':
      return send(ws, { kind: 'pong' })

    case 'printers': {
      const printers = await deps.engine.listPrinters()
      return send(ws, { kind: 'printers', printers })
    }

    case 'pair': {
      const record = deps.registry.ensure(origin ?? msg.origin)
      if (record) {
        return send(ws, { kind: 'paired', secret: record.token, agentId: deps.store.get().agentId })
      }
      return send(ws, { kind: 'pair_denied' })
    }

    case 'job': {
      const parsed = parsePrintJob(msg.job)
      if (!parsed.ok) {
        const id = (msg.job as { id?: string } | undefined)?.id
        return send(ws, { kind: 'error', id, error: parsed.error })
      }
      const auth = authorizeJob(parsed.job, origin, deps.registry, deps.nonces)
      if (!auth.ok) {
        if (auth.reason === 'unpaired') return send(ws, { kind: 'pair_required' })
        return send(ws, { kind: 'error', id: parsed.job.id, error: auth.error ?? 'unauthorized' })
      }
      send(ws, { kind: 'ack', v: PROTOCOL_VERSION, id: parsed.job.id, status: 'queued', ts: Date.now() })
      const result = await deps.engine.enqueue(parsed.job, origin)
      return send(ws, { kind: 'result', ...result })
    }

    default:
      return send(ws, { kind: 'error', error: 'unknown message kind' })
  }
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
}
