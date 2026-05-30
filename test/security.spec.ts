import { describe, it, expect } from 'vitest'
import { signJob, verifyJob, generateSecret } from '../src/main/security/hmac'
import { NonceCache } from '../src/main/security/nonce'
import type { PrintJob } from '@shared/types'

const baseJob: PrintJob = {
  v: 1,
  id: 'job-1',
  type: 'pdf',
  source: { url: 'https://example.com/r.pdf' },
  ts: 1_700_000_000_000,
  nonce: 'abc123',
}

describe('hmac signing', () => {
  it('round-trips: a signed job verifies', () => {
    const secret = generateSecret()
    const signature = signJob(baseJob, secret)
    expect(verifyJob({ ...baseJob, signature }, secret)).toBe(true)
  })

  it('fails when the job is tampered', () => {
    const secret = generateSecret()
    const signature = signJob(baseJob, secret)
    const tampered: PrintJob = { ...baseJob, signature, copies: 99 }
    expect(verifyJob(tampered, secret)).toBe(false)
  })

  it('fails with the wrong secret', () => {
    const signature = signJob(baseJob, generateSecret())
    expect(verifyJob({ ...baseJob, signature }, generateSecret())).toBe(false)
  })

  it('fails when there is no signature', () => {
    expect(verifyJob(baseJob, generateSecret())).toBe(false)
  })

  it('produces a 64-char hex secret', () => {
    expect(generateSecret()).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('NonceCache', () => {
  it('reports a nonce as seen only after it is added', () => {
    const cache = new NonceCache()
    expect(cache.seen('n1')).toBe(false)
    cache.add('n1')
    expect(cache.seen('n1')).toBe(true)
    expect(cache.seen('n2')).toBe(false)
  })
})
