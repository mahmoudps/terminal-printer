import { describe, it, expect, beforeEach, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { WebsiteJob } from '@shared/types'

// The registry pulls electron through util/paths and util/log — stub both so the
// pure registry logic can be tested under the node test environment.
const h = vi.hoisted(() => ({ file: '' }))
vi.mock('../src/main/util/log', () => ({
  scoped: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}))
vi.mock('../src/main/util/paths', () => ({
  userDataFile: () => h.file,
}))

import { WebsiteRegistry } from '../src/main/websites/registry'

const printedJob = (id: string): WebsiteJob => ({
  id,
  type: 'pdf',
  printer: null,
  status: 'printed',
  at: 1,
})
const onlineOf = (r: WebsiteRegistry, origin: string): boolean =>
  !!r.list().find((s) => s.origin === origin)?.online

beforeEach(() => {
  h.file = join(tmpdir(), `tp-sites-${randomUUID()}.json`)
})

describe('WebsiteRegistry', () => {
  it('auto-approves a new origin and issues a 64-hex token', () => {
    const r = new WebsiteRegistry()
    const rec = r.ensure('https://shop.example')
    expect(rec).not.toBeNull()
    expect(rec!.token).toMatch(/^[0-9a-f]{64}$/)
    expect(r.tokenFor('https://shop.example')).toBe(rec!.token)
  })

  it('blocks an origin: ensure() returns null and there is no token', () => {
    const r = new WebsiteRegistry()
    r.ensure('https://a.example')
    r.setBlocked('https://a.example', true)
    expect(r.ensure('https://a.example')).toBeNull()
    expect(r.isBlocked('https://a.example')).toBe(true)
  })

  it('counts overlapping sessions symmetrically', () => {
    const r = new WebsiteRegistry()
    const o = 'https://a.example'
    expect(r.markConnected(o)).toBe(true)
    expect(r.markConnected(o)).toBe(true) // two tabs open
    expect(onlineOf(r, o)).toBe(true)
    r.markDisconnected(o)
    expect(onlineOf(r, o)).toBe(true) // one still open
    r.markDisconnected(o)
    expect(onlineOf(r, o)).toBe(false) // both closed
  })

  it('does not count a blocked connection and a stray disconnect cannot drift negative', () => {
    const r = new WebsiteRegistry()
    const o = 'https://b.example'
    r.ensure(o)
    r.setBlocked(o, true)
    expect(r.markConnected(o)).toBe(false) // blocked → not counted
    r.markDisconnected(o) // must be a no-op, not -1
    expect(onlineOf(r, o)).toBe(false)
    // After unblocking, a single connect/disconnect pair returns cleanly to 0.
    r.setBlocked(o, false)
    expect(r.markConnected(o)).toBe(true)
    r.markDisconnected(o)
    expect(onlineOf(r, o)).toBe(false)
  })

  it('recordJob never auto-creates a site for synthetic origins (cloud/desktop)', () => {
    const r = new WebsiteRegistry()
    r.recordJob('cloud', printedJob('j1'))
    r.recordJob('desktop', printedJob('j2'))
    expect(r.list()).toHaveLength(0)
    expect(r.tokenFor('cloud')).toBeUndefined()
  })

  it('recordJob appends history for an existing site', () => {
    const r = new WebsiteRegistry()
    const o = 'https://shop.example'
    r.ensure(o)
    r.recordJob(o, printedJob('j1'))
    const d = r.detail(o)!
    expect(d.jobs).toHaveLength(1)
    expect(d.jobs[0].id).toBe('j1')
  })

  it('flush() persists and load() restores the same token', async () => {
    const r = new WebsiteRegistry()
    await r.load()
    const rec = r.ensure('https://persist.example')
    await r.flush()
    const r2 = new WebsiteRegistry()
    await r2.load()
    expect(r2.tokenFor('https://persist.example')).toBe(rec!.token)
  })
})
