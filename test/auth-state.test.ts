import { describe, it, expect } from 'vitest'
import { signState, verifyState } from '../src/auth/state'

const secret = 'session-secret'

describe('signed CSRF state', () => {
  it('verifyState accepts a freshly signed value', () => {
    const state = signState(secret)
    expect(verifyState(state, secret)).toBe(true)
  })

  it('signState produces a fresh nonce each call', () => {
    expect(signState(secret)).not.toBe(signState(secret))
  })

  it('rejects a tampered state', () => {
    const state = signState(secret)
    const [nonce, sig] = state.split('.')
    const tampered = `${nonce}x.${sig}`
    expect(verifyState(tampered, secret)).toBe(false)
  })

  it('rejects garbage', () => {
    expect(verifyState('garbage', secret)).toBe(false)
    expect(verifyState('', secret)).toBe(false)
    expect(verifyState('a.b.c', secret)).toBe(false)
  })

  it('rejects a state signed with a different secret', () => {
    const state = signState('other-secret')
    expect(verifyState(state, secret)).toBe(false)
  })
})
