import net from 'node:net'

/** Send raw bytes to a network printer (e.g. a thermal printer on TCP 9100). */
export function sendTcp(host: string, port: number, data: Buffer, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const done = (err?: Error) => {
      if (settled) return
      settled = true
      socket.destroy()
      err ? reject(err) : resolve()
    }
    const socket = net.createConnection({ host, port })
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      socket.write(data, () => {
        // Give the printer a beat to drain, then close cleanly.
        socket.end()
      })
    })
    socket.once('timeout', () => done(new Error(`tcp timeout to ${host}:${port}`)))
    socket.once('error', (err) => done(err))
    socket.once('close', () => done())
  })
}
