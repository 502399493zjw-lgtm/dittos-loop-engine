import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Signed, stateless CSRF state for the OAuth round-trip.
 *
 * state = base64url(nonce) + '.' + base64url(hmacSHA256(nonce, secret))
 *
 * /auth/login mints one; /auth/callback recomputes the HMAC over the nonce and
 * compares it constant-time. No server-side state storage — the signature is
 * the proof. (node:crypto only, no dep.)
 */

const sign = (nonce: string, secret: string): string =>
  createHmac('sha256', secret).update(nonce).digest('base64url')

export function signState(secret: string): string {
  const nonce = randomBytes(16).toString('base64url')
  return `${nonce}.${sign(nonce, secret)}`
}

export function verifyState(state: string, secret: string): boolean {
  const parts = state.split('.')
  if (parts.length !== 2) return false
  const [nonce, sig] = parts
  if (!nonce || !sig) return false
  const expected = sign(nonce, secret)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
