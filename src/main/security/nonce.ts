import { NONCE_TTL_MS } from '@shared/constants'

/** Remembers recently-seen nonces to reject replays. Self-evicting. */
export class NonceCache {
  private seenMap = new Map<string, number>()

  seen(nonce: string): boolean {
    this.gc()
    return this.seenMap.has(nonce)
  }

  add(nonce: string): void {
    this.seenMap.set(nonce, Date.now() + NONCE_TTL_MS)
  }

  private gc(): void {
    const now = Date.now()
    for (const [key, expiry] of this.seenMap) {
      if (expiry < now) this.seenMap.delete(key)
    }
  }
}
