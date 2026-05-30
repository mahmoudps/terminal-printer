import http from 'node:http'
import type { WebSocketServer } from 'ws'
import { scoped } from '../util/log'
import { createHttpServer } from './http'
import { attachWebSocket } from './ws'
import type { ServerDeps } from './deps'

const log = scoped('server')

/**
 * Owns the loopback HTTP + WebSocket server. Binds to 127.0.0.1 only, trying a
 * list of ports until one is free. Restartable when the configured port changes.
 */
export class LocalServer {
  private server: http.Server | null = null
  private wss: WebSocketServer | null = null
  private boundPort = 0

  constructor(private readonly deps: ServerDeps) {}

  get port(): number {
    return this.boundPort
  }

  get running(): boolean {
    return this.server != null
  }

  /** Try each port in order; resolves with the one that bound. */
  async start(ports: number[]): Promise<number> {
    await this.stop()
    let lastErr: unknown
    for (const port of ports) {
      try {
        await this.listen(port)
        this.boundPort = port
        log.info(`listening on 127.0.0.1:${port}`)
        return port
      } catch (err) {
        lastErr = err
        if ((err as NodeJS.ErrnoException)?.code === 'EADDRINUSE') {
          log.warn(`port ${port} in use, trying next`)
          continue
        }
        throw err
      }
    }
    throw new Error(`could not bind any port (${ports.join(', ')}): ${String(lastErr)}`)
  }

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createHttpServer(this.deps)
      let settled = false
      const onError = (err: Error) => {
        if (settled) return
        settled = true
        reject(err)
      }
      server.once('error', onError)
      server.listen(port, '127.0.0.1', () => {
        if (settled) return
        settled = true
        server.off('error', onError)
        // Attach the WebSocket server only AFTER the HTTP server is listening.
        // `ws` re-emits the http server's 'error' onto the WebSocketServer
        // instance, so attaching before listen() would swallow EADDRINUSE here
        // and leave this promise unsettled (the agent would hang on a busy port).
        this.server = server
        this.wss = attachWebSocket(server, this.deps)
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    if (this.wss) {
      this.wss.close()
      this.wss = null
    }
    if (this.server) {
      const server = this.server
      this.server = null
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    this.boundPort = 0
  }
}
