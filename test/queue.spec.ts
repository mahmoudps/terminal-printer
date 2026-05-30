import { describe, it, expect } from 'vitest'
import { PrintQueue, type QueueConfig } from '../src/main/printing/queue'
import type { JobResult, PrintJob } from '@shared/types'

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
const config = (over: Partial<QueueConfig> = {}): (() => QueueConfig) => () => ({
  maxConcurrent: 2,
  maxAttempts: 1,
  retryBackoffMs: 10,
  historyLimit: 100,
  persist: false,
  ...over,
})
const job = (id: string): PrintJob => ({ v: 1, id, type: 'raw', source: { text: 'x' } })
const ok = (): JobResult => ({ v: 1, id: '', status: 'printed', ts: Date.now() })
const fail = (e: string): JobResult => ({ v: 1, id: '', status: 'failed', error: e, ts: Date.now() })
const add = (q: PrintQueue, id: string, printerKey: string) =>
  q.add({ job: job(id), printerName: printerKey, printerKey })

describe('PrintQueue', () => {
  it('respects maxConcurrent across different printers', async () => {
    let active = 0
    let peak = 0
    const runner = async () => {
      active++
      peak = Math.max(peak, active)
      await delay(25)
      active--
      return ok()
    }
    const q = new PrintQueue(config({ maxConcurrent: 2 }), runner)
    await Promise.all(['a', 'b', 'c', 'd'].map((k, i) => add(q, 'j' + i, k)))
    expect(peak).toBeLessThanOrEqual(2)
    expect(peak).toBeGreaterThan(1) // genuinely parallel
  })

  it('serializes jobs on the same printer', async () => {
    const order: string[] = []
    const runner = async (j: PrintJob) => {
      order.push(j.id + ':start')
      await delay(15)
      order.push(j.id + ':end')
      return ok()
    }
    const q = new PrintQueue(config({ maxConcurrent: 4 }), runner)
    await Promise.all([add(q, '1', 'p'), add(q, '2', 'p')])
    expect(order).toEqual(['1:start', '1:end', '2:start', '2:end'])
  })

  it('runs different printers in parallel', async () => {
    const running = new Set<string>()
    let bothRanTogether = false
    const runner = async (j: PrintJob) => {
      running.add(j.id)
      if (running.size === 2) bothRanTogether = true
      await delay(20)
      running.delete(j.id)
      return ok()
    }
    const q = new PrintQueue(config({ maxConcurrent: 2 }), runner)
    await Promise.all([add(q, 'x', 'p1'), add(q, 'y', 'p2')])
    expect(bothRanTogether).toBe(true)
  })

  it('retries a failing job then succeeds', async () => {
    let attempts = 0
    const runner = async () => {
      attempts++
      return attempts < 2 ? fail('boom') : ok()
    }
    const q = new PrintQueue(config({ maxAttempts: 2, retryBackoffMs: 5 }), runner)
    const r = await add(q, 'x', 'p')
    expect(r.status).toBe('printed')
    expect(attempts).toBe(2)
  })

  it('gives up after maxAttempts', async () => {
    let attempts = 0
    const runner = async () => {
      attempts++
      return fail('always')
    }
    const q = new PrintQueue(config({ maxAttempts: 3, retryBackoffMs: 5 }), runner)
    const r = await add(q, 'x', 'p')
    expect(r.status).toBe('failed')
    expect(attempts).toBe(3)
  })

  it('cancels a queued job', async () => {
    const runner = async () => {
      await delay(40)
      return ok()
    }
    const q = new PrintQueue(config({ maxConcurrent: 1 }), runner)
    const p1 = add(q, 'a', 'p1') // takes the only slot
    const p2 = add(q, 'b', 'p2') // queued behind the cap
    q.cancel('b')
    const r2 = await p2
    expect(r2.status).toBe('failed')
    expect(r2.error).toBe('canceled')
    await p1
  })

  it('rejects a duplicate id while the first is still live', async () => {
    const runner = async () => {
      await delay(40)
      return ok()
    }
    const q = new PrintQueue(config({ maxConcurrent: 1 }), runner)
    const p1 = add(q, 'dup', 'p1') // starts printing immediately
    const p2 = add(q, 'dup', 'p2') // same id while the first is live → rejected
    const r2 = await p2
    expect(r2.status).toBe('failed')
    expect(r2.error).toMatch(/duplicate/i)
    expect((await p1).status).toBe('printed')
  })

  it('reports queue/history in snapshot', async () => {
    const runner = async () => ok()
    const q = new PrintQueue(config(), runner)
    await add(q, 'a', 'p')
    const snap = q.snapshot()
    expect(snap.history.find((j) => j.id === 'a')?.state).toBe('done')
  })

  it('persists queued jobs via persistFn', async () => {
    let saved: { id: string }[] = []
    const runner = async () => {
      await delay(40)
      return ok()
    }
    const q = new PrintQueue(config({ maxConcurrent: 1, persist: true }), runner, (recs) => {
      saved = recs.map((r) => ({ id: r.id }))
    })
    add(q, 'a', 'p') // starts immediately
    add(q, 'b', 'p') // queued
    await delay(5)
    expect(saved.some((r) => r.id === 'b')).toBe(true)
  })
})
