import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { jsonUserStore } from '../src/auth/jsonUserStore'
import { jsonTokenStore } from '../src/auth/jsonTokenStore'

// A deterministic clock so createdAt is predictable across assertions.
const clock = (start = 1000, step = 1000) => {
  let t = start - step
  return () => (t += step)
}

describe('jsonUserStore', () => {
  it('upsertByGithub creates a User with id + createdAt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'us-'))
    const s = jsonUserStore(dir, { now: clock() })
    const u = await s.upsertByGithub({ id: 42, login: 'octocat', name: 'Octo Cat' })
    expect(u.id).toBeTruthy()
    expect(u.githubId).toBe(42)
    expect(u.login).toBe('octocat')
    expect(u.name).toBe('Octo Cat')
    expect(u.createdAt).toBe(1000)
  })

  it('upsertByGithub returns the SAME user for the same githubId (no dup)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'us-'))
    const s = jsonUserStore(dir, { now: clock() })
    const first = await s.upsertByGithub({ id: 42, login: 'octocat' })
    const again = await s.upsertByGithub({ id: 42, login: 'octocat-renamed', name: 'Renamed' })
    expect(again.id).toBe(first.id)
    expect(again.createdAt).toBe(first.createdAt)
    // login/name refreshed from GitHub on re-login
    expect(again.login).toBe('octocat-renamed')
    expect(again.name).toBe('Renamed')
    // exactly one user persisted
    const back = await s.getById(first.id)
    expect(back?.id).toBe(first.id)
  })

  it('getById returns the user, undefined for unknown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'us-'))
    const s = jsonUserStore(dir, { now: clock() })
    const u = await s.upsertByGithub({ id: 7, login: 'mona' })
    expect((await s.getById(u.id))?.login).toBe('mona')
    expect(await s.getById('nope')).toBeUndefined()
  })

  it('persistence survives a fresh jsonUserStore on the same dir; no dup across instances', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'us-'))
    const s1 = jsonUserStore(dir, { now: clock() })
    const u = await s1.upsertByGithub({ id: 99, login: 'kept', name: 'Kept' })

    const s2 = jsonUserStore(dir, { now: clock() })
    expect((await s2.getById(u.id))?.login).toBe('kept')
    const again = await s2.upsertByGithub({ id: 99, login: 'kept' })
    expect(again.id).toBe(u.id)
  })
})

describe('jsonTokenStore', () => {
  it('issue -> resolve round-trips to the userId', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-'))
    const s = jsonTokenStore(dir)
    const token = await s.issue('user-1')
    expect(token).toBeTruthy()
    expect(await s.resolve(token)).toBe('user-1')
  })

  it('resolve(unknown) returns undefined', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-'))
    const s = jsonTokenStore(dir)
    expect(await s.resolve('not-a-real-token')).toBeUndefined()
  })

  it('issuing twice for the same user yields distinct tokens, both resolving', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-'))
    const s = jsonTokenStore(dir)
    const a = await s.issue('user-1')
    const b = await s.issue('user-1')
    expect(a).not.toBe(b)
    expect(await s.resolve(a)).toBe('user-1')
    expect(await s.resolve(b)).toBe('user-1')
  })

  it('persistence survives a fresh jsonTokenStore on the same dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-'))
    const s1 = jsonTokenStore(dir)
    const token = await s1.issue('user-7')

    const s2 = jsonTokenStore(dir)
    expect(await s2.resolve(token)).toBe('user-7')
  })
})
