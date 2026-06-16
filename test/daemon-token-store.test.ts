import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { jsonDaemonTokenStore, inMemoryDaemonTokenStore } from '../src/daemon/daemonTokenStore'
import type { DaemonTokenStore } from '../src/daemon/daemonTokenStore'

// Both stores satisfy the same contract; run the shared cases over each.
const stores: Array<[string, () => DaemonTokenStore]> = [
  ['inMemoryDaemonTokenStore', () => inMemoryDaemonTokenStore()],
  ['jsonDaemonTokenStore', () => jsonDaemonTokenStore(mkdtempSync(join(tmpdir(), 'daemon-tok-')))],
]

for (const [name, make] of stores) {
  describe(`DaemonTokenStore — ${name}`, () => {
    it('issue mints a token that resolves back to the userId', async () => {
      const store = make()
      const token = await store.issue('user-1')
      expect(typeof token).toBe('string')
      expect(token.length).toBeGreaterThan(0)
      expect(await store.resolve(token)).toBe('user-1')
    })

    it('resolve is undefined for an unknown token', async () => {
      const store = make()
      expect(await store.resolve('nope')).toBeUndefined()
    })

    it('issue mints a fresh token each call; both resolve to the same user', async () => {
      const store = make()
      const a = await store.issue('user-1')
      const b = await store.issue('user-1')
      expect(a).not.toBe(b)
      expect(await store.resolve(a)).toBe('user-1')
      expect(await store.resolve(b)).toBe('user-1')
    })

    it('keeps tokens for distinct users separate', async () => {
      const store = make()
      const a = await store.issue('alice')
      const b = await store.issue('bob')
      expect(await store.resolve(a)).toBe('alice')
      expect(await store.resolve(b)).toBe('bob')
    })
  })
}

describe('jsonDaemonTokenStore — persistence + hashing', () => {
  it('persists across store instances over the same dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daemon-tok-persist-'))
    const a = jsonDaemonTokenStore(dir)
    const token = await a.issue('user-1')
    const b = jsonDaemonTokenStore(dir)
    expect(await b.resolve(token)).toBe('user-1')
  })

  it('stores the sha256 of the token, never the raw token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daemon-tok-hash-'))
    const store = jsonDaemonTokenStore(dir)
    const token = await store.issue('user-1')
    const { readFileSync, readdirSync } = await import('node:fs')
    const files = readdirSync(dir)
    const raw = files.map((f) => readFileSync(join(dir, f), 'utf8')).join('')
    // The raw token must not appear on disk; the userId is fine to persist.
    expect(raw).not.toContain(token)
    expect(raw).toContain('user-1')
  })
})
