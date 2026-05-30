import { REPLAY_WINDOW_MS } from '@shared/constants'
import type { PrintJob } from '@shared/types'
import { verifyJob } from './hmac'
import type { NonceCache } from './nonce'
import type { WebsiteRegistry } from '../websites/registry'

export interface AuthResult {
  ok: boolean
  /** 'unpaired' tells the caller to (auto-)register the site. */
  reason?: 'unpaired' | 'blocked' | 'stale' | 'replay' | 'missing-origin' | 'missing-fields' | 'bad-signature'
  error?: string
}

/**
 * A job may print only if its origin is a registered (not blocked) website,
 * the job is fresh (ts within the replay window) with an unseen nonce, and its
 * HMAC verifies against that site's token.
 */
export function authorizeJob(
  job: PrintJob,
  origin: string | undefined,
  registry: WebsiteRegistry,
  nonces: NonceCache,
): AuthResult {
  if (!origin) return { ok: false, reason: 'missing-origin', error: 'missing origin' }
  if (registry.isBlocked(origin)) return { ok: false, reason: 'blocked', error: 'site is blocked' }

  const token = registry.tokenFor(origin)
  if (!token) return { ok: false, reason: 'unpaired', error: 'site not registered' }

  if (job.ts == null || !job.nonce) {
    return { ok: false, reason: 'missing-fields', error: 'missing ts or nonce' }
  }
  if (Math.abs(Date.now() - job.ts) > REPLAY_WINDOW_MS) {
    return { ok: false, reason: 'stale', error: 'stale timestamp' }
  }
  if (nonces.seen(job.nonce)) {
    return { ok: false, reason: 'replay', error: 'replayed nonce' }
  }
  if (!verifyJob(job, token)) {
    return { ok: false, reason: 'bad-signature', error: 'bad signature' }
  }

  nonces.add(job.nonce)
  return { ok: true }
}
