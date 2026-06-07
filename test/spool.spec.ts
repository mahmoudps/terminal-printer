import { describe, it, expect, vi } from 'vitest'
import net from 'node:net'

// The listener pulls electron-log through util/log — stub it.
vi.mock('../src/main/util/log', () => ({
  scoped: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}))

import { SpoolListener } from '../src/main/spool/listener'

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function sendBytes(port: number, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = net.connect(port, '127.0.0.1', () => {
      c.write(data)
      c.end()
    })
    c.on('error', reject)
    c.on('close', () => resolve())
  })
}

describe('SpoolListener', () => {
  it('captures a spooled job and delivers the bytes once', async () => {
    const jobs: Buffer[] = []
    const l = new SpoolListener((d) => jobs.push(d))
    await l.start(19151)
    expect(l.running).toBe(true)
    expect(l.boundPort).toBe(19151)

    await sendBytes(19151, Buffer.from('HELLO RECEIPT\n'))
    await delay(60)

    expect(jobs).toHaveLength(1)
    expect(jobs[0].toString()).toBe('HELLO RECEIPT\n')

    await l.stop()
    expect(l.running).toBe(false)
  })

  it('drops a job that exceeds the size cap', async () => {
    const jobs: Buffer[] = []
    const l = new SpoolListener((d) => jobs.push(d), 16) // 16-byte cap
    await l.start(19152)
    await sendBytes(19152, Buffer.alloc(200, 65)) // 200 bytes > cap
    await delay(60)
    expect(jobs).toHaveLength(0) // oversized → dropped, not delivered
    await l.stop()
  })

  it('reassembles a job split across multiple writes', async () => {
    const jobs: Buffer[] = []
    const l = new SpoolListener((d) => jobs.push(d))
    await l.start(19153)
    await new Promise<void>((resolve, reject) => {
      const c = net.connect(19153, '127.0.0.1', () => {
        c.write('part-A;')
        setTimeout(() => {
          c.write('part-B')
          c.end()
        }, 20)
      })
      c.on('error', reject)
      c.on('close', () => resolve())
    })
    await delay(60)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].toString()).toBe('part-A;part-B')
    await l.stop()
  })
})
