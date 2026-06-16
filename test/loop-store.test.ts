import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { jsonLoopStore } from '../src/loop/jsonLoopStore'
import type { LoopSpec } from '../src/loop/types'

const spec = (id: string): LoopSpec => ({ id, flow: 'demo', trigger: { kind: 'interval', everyMs: 1000 } })

describe('jsonLoopStore', () => {
  it('upsert then get returns spec + default state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-'))
    const s = jsonLoopStore(dir)
    await s.upsert(spec('a'))
    const got = await s.get('a')
    expect(got?.spec).toEqual(spec('a'))
    expect(got?.state).toEqual({ cursor: null, consecutiveFailures: 0, paused: false })
  })

  it('get returns undefined for an unknown loop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-'))
    const s = jsonLoopStore(dir)
    expect(await s.get('nope')).toBeUndefined()
  })

  it('upsert preserves existing state (does not reset)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-'))
    const s = jsonLoopStore(dir)
    await s.upsert(spec('a'))
    await s.setState('a', { consecutiveFailures: 2, cursor: 5 })
    await s.upsert({ ...spec('a'), budgetUsd: 0.5 })
    const got = await s.get('a')
    expect(got?.spec.budgetUsd).toBe(0.5)
    expect(got?.state).toEqual({ cursor: 5, consecutiveFailures: 2, paused: false })
  })

  it('setState merges into existing state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-'))
    const s = jsonLoopStore(dir)
    await s.upsert(spec('a'))
    await s.setState('a', { consecutiveFailures: 1 })
    await s.setState('a', { paused: true, pausedReason: 'failures' })
    const got = await s.get('a')
    expect(got?.state).toEqual({ cursor: null, consecutiveFailures: 1, paused: true, pausedReason: 'failures' })
  })

  it('list returns all stored loops', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-'))
    const s = jsonLoopStore(dir)
    await s.upsert(spec('a'))
    await s.upsert(spec('b'))
    const all = await s.list()
    expect(all.map((x) => x.spec.id).sort()).toEqual(['a', 'b'])
  })

  it('list returns [] for an empty dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-'))
    const s = jsonLoopStore(dir)
    expect(await s.list()).toEqual([])
  })
})
