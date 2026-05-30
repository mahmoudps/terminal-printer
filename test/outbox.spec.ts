import { describe, it, expect, beforeEach, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// Outbox pulls electron through util/paths and util/log — stub both.
const h = vi.hoisted(() => ({ file: '' }))
vi.mock('../src/main/util/log', () => ({
  scoped: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}))
vi.mock('../src/main/util/paths', () => ({
  userDataFile: () => h.file,
}))

import { Outbox } from '../src/main/cloud/outbox'

beforeEach(() => {
  h.file = join(tmpdir(), `tp-outbox-${randomUUID()}.json`)
})

describe('Outbox', () => {
  it('caps the backlog so it cannot grow unbounded', async () => {
    const o = new Outbox()
    await o.load()
    for (let i = 0; i < 510; i++) await o.add({ url: 'u' + i, body: {} })
    let sent = 0
    await o.flush(async () => {
      sent++
    })
    expect(sent).toBe(500) // oldest beyond the cap were dropped
  })

  it('discards items older than the TTL', async () => {
    const o = new Outbox()
    await o.load()
    await o.add({ url: 'ancient', body: {}, at: 1 }) // ~1970 → expired
    await o.add({ url: 'fresh', body: {} })
    const urls: string[] = []
    await o.flush(async (it) => {
      urls.push(it.url)
    })
    expect(urls).toEqual(['fresh'])
  })

  it('re-queues items whose send fails', async () => {
    const o = new Outbox()
    await o.load()
    await o.add({ url: 'a', body: {} })
    await o.flush(async () => {
      throw new Error('network down')
    })
    // The failed item should still be there on the next flush.
    let sent = 0
    await o.flush(async () => {
      sent++
    })
    expect(sent).toBe(1)
  })
})
