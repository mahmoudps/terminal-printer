import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { canonicalJob } from '@shared/schema'
import type { PrintJob } from '@shared/types'

/** 32-byte shared secret (hex) handed to a page on successful pairing. */
export function generateSecret(): string {
  return randomBytes(32).toString('hex')
}

/** HMAC-SHA256 (hex) over the canonical job, using the pairing secret. */
export function signJob(job: PrintJob, secret: string): string {
  return createHmac('sha256', secret).update(canonicalJob(job)).digest('hex')
}

export function verifyJob(job: PrintJob, secret: string): boolean {
  if (!job.signature) return false
  const expected = signJob(job, secret)
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(job.signature, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
