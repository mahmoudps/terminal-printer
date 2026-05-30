import { describe, it, expect } from 'vitest'
import { parsePrintJob, stableStringify, canonicalJob } from '@shared/schema'
import type { PrintJob } from '@shared/types'

const validPdf: PrintJob = {
  v: 1,
  id: 'job-1',
  type: 'pdf',
  source: { url: 'https://example.com/receipt.pdf' },
  options: { paperSize: 'A5' },
}

describe('parsePrintJob', () => {
  it('accepts a valid pdf job', () => {
    const res = parsePrintJob(validPdf)
    expect(res.ok).toBe(true)
  })

  it('rejects a job with two sources', () => {
    const res = parsePrintJob({ ...validPdf, source: { url: 'https://x/y.pdf', text: 'hi' } })
    expect(res.ok).toBe(false)
  })

  it('rejects a job with no source', () => {
    const res = parsePrintJob({ ...validPdf, source: {} })
    expect(res.ok).toBe(false)
  })

  it('rejects an unknown type', () => {
    const res = parsePrintJob({ ...validPdf, type: 'doc' })
    expect(res.ok).toBe(false)
  })

  it('rejects a non-url url source', () => {
    const res = parsePrintJob({ ...validPdf, source: { url: 'not a url' } })
    expect(res.ok).toBe(false)
  })
})

describe('stableStringify', () => {
  it('is deterministic regardless of key order', () => {
    const a = stableStringify({ b: 1, a: { y: 2, x: 1 } })
    const b = stableStringify({ a: { x: 1, y: 2 }, b: 1 })
    expect(a).toBe(b)
  })

  it('drops undefined values', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}')
  })

  it('preserves array order', () => {
    expect(stableStringify({ a: [3, 1, 2] })).toBe('{"a":[3,1,2]}')
  })
})

describe('canonicalJob', () => {
  it('excludes the signature field', () => {
    const signed: PrintJob = { ...validPdf, signature: 'deadbeef' }
    expect(canonicalJob(signed)).toBe(canonicalJob(validPdf))
    expect(canonicalJob(signed)).not.toContain('deadbeef')
  })
})
