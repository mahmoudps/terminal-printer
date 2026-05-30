import { describe, it, expect, vi } from 'vitest'
import { tmpdir } from 'node:os'
import WebSocket from 'ws'
import { NonceCache } from '../src/main/security/nonce'
import type { ServerDeps } from '../src/main/server/deps'

// LocalServer pulls electron (app) and electron-log through util/log — stub both.
vi.mock('../src/main/util/log', () => ({
  scoped: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}))
vi.mock('electron', () => ({
  app: {
    getName: () => 'Terminal Printer',
    getVersion: () => '0.0.0-test',
    getPath: () => tmpdir(),
  },
}))

import { LocalServer } from '../src/main/server'

function makeDeps(): ServerDeps {
  return {
    engine: {
      listPrinters: async () => [],
      enqueue: async () => ({ v: 1, id: 'x', status: 'printed', ts: 0 }),
    },
    registry: {
      markConnected: () => true,
      markDisconnected: () => {},
      tokenFor: () => undefined,
      isBlocked: () => false,
      ensure: () => null,
    },
    nonces: new NonceCache(),
    store: { get: () => ({ agentId: 'test', paused: false }) },
  } as unknown as ServerDeps
}

describe('LocalServer', () => {
  it('stops promptly even with a live WebSocket client connected', async () => {
    const server = new LocalServer(makeDeps())
    const port = await server.start([19130, 19131, 19132])
    expect(server.running).toBe(true)

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: 'http://probe.test' })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', reject)
    })

    // The bug: closing an external-server WebSocketServer doesn't terminate live
    // sockets, and http server.close() waits for them — so this would hang.
    const t0 = Date.now()
    await server.stop()
    const elapsed = Date.now() - t0
    expect(elapsed).toBeLessThan(1500)
    expect(server.running).toBe(false)
    try {
      ws.terminate()
    } catch {
      /* already gone */
    }
  })

  it('skips a busy port and binds the next free one (EADDRINUSE)', async () => {
    const first = new LocalServer(makeDeps())
    const p1 = await first.start([19140])
    expect(p1).toBe(19140)

    const second = new LocalServer(makeDeps())
    const p2 = await second.start([19140, 19141])
    expect(p2).toBe(19141) // 19140 busy → fell through to 19141

    await first.stop()
    await second.stop()
  })
})
