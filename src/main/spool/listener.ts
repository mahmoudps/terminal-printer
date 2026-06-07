import net from 'node:net'
import { scoped } from '../util/log'

const log = scoped('spool')

/**
 * Loopback TCP "spool" listener — the agent side of the **virtual printer**.
 *
 * A system printer (added by the OS-registration scripts) points a Standard
 * TCP/IP RAW port at 127.0.0.1:<listenPort>. When any desktop app prints to it,
 * the OS streams the spooled bytes here; we collect them and hand the buffer to
 * `onJob` (which routes it through the print engine or saves a capture).
 *
 * Loopback-only bind. Each print job is one TCP connection (RAW protocol): read
 * until the peer closes, then deliver. Size-capped so a runaway job can't OOM us.
 */
export class SpoolListener {
  private server: net.Server | null = null
  private port = 0
  private readonly sockets = new Set<net.Socket>()

  constructor(
    private readonly onJob: (data: Buffer) => void,
    private readonly maxBytes = 64 * 1024 * 1024,
  ) {}

  get running(): boolean {
    return this.server != null
  }

  get boundPort(): number {
    return this.port
  }

  async start(port: number): Promise<void> {
    await this.stop()
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((sock) => {
        this.sockets.add(sock)
        sock.on('close', () => this.sockets.delete(sock))
        const chunks: Buffer[] = []
        let size = 0
        let aborted = false
        sock.on('data', (c: Buffer) => {
          size += c.length
          if (size > this.maxBytes) {
            aborted = true
            log.warn(`spool job exceeded ${this.maxBytes} bytes — dropping`)
            sock.destroy()
            return
          }
          chunks.push(c)
        })
        sock.on('end', () => {
          if (aborted) return
          const data = Buffer.concat(chunks)
          if (data.length) {
            log.info(`captured spool job (${data.length} bytes)`)
            try {
              this.onJob(data)
            } catch (err) {
              log.error('spool onJob failed:', String(err))
            }
          }
        })
        sock.on('error', () => {
          /* client reset mid-spool — ignore */
        })
      })
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject)
        server.on('error', (e) => log.error('spool server error:', String(e)))
        this.server = server
        this.port = port
        log.info(`virtual-printer spool listening on 127.0.0.1:${port}`)
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    if (!this.server) return
    const server = this.server
    this.server = null
    this.port = 0
    for (const s of this.sockets) s.destroy()
    this.sockets.clear()
    await new Promise<void>((resolve) => {
      let done = false
      const finish = (): void => {
        if (!done) {
          done = true
          resolve()
        }
      }
      server.close(() => finish())
      setTimeout(finish, 1500).unref?.()
    })
  }
}
