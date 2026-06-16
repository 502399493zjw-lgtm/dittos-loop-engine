import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { jsonTraceStore } from '../src/chat/traceStore'

const clock = (start = 1000, step = 1000) => {
  let t = start - step
  return () => (t += step)
}

describe('jsonTraceStore', () => {
  it('append assigns a monotonic seq per turn starting at 0', async () => {
    const s = jsonTraceStore(mkdtempSync(join(tmpdir(), 'tr-')), { now: clock() })
    const e0 = await s.append('turn-1', { kind: 'thinking', payload: { content: 'hmm' } })
    const e1 = await s.append('turn-1', { kind: 'tool_use_start', payload: { tool_name: 'Read' } })
    expect(e0.seq).toBe(0)
    expect(e1.seq).toBe(1)
    expect(e0.turn_id).toBe('turn-1')
    expect(e0.kind).toBe('thinking')
    expect(e0.payload).toEqual({ content: 'hmm' })
    expect(e0.created_at).toBe(1000)
  })

  it('severity defaults to info and is overridable', async () => {
    const s = jsonTraceStore(mkdtempSync(join(tmpdir(), 'tr-')), { now: clock() })
    const info = await s.append('t', { kind: 'text', payload: {} })
    const err = await s.append('t', { kind: 'error', severity: 'error', payload: { error: 'boom' } })
    expect(info.severity).toBe('info')
    expect(err.severity).toBe('error')
  })

  it('preserves optional parent_event_id', async () => {
    const s = jsonTraceStore(mkdtempSync(join(tmpdir(), 'tr-')), { now: clock() })
    const e = await s.append('t', { kind: 'tool_use_result', parent_event_id: 'ev-1', payload: { output: 'ok' } })
    expect(e.parent_event_id).toBe('ev-1')
  })

  it('seq is independent per turn', async () => {
    const s = jsonTraceStore(mkdtempSync(join(tmpdir(), 'tr-')), { now: clock() })
    const a0 = await s.append('A', { kind: 'text', payload: {} })
    const b0 = await s.append('B', { kind: 'text', payload: {} })
    const a1 = await s.append('A', { kind: 'text', payload: {} })
    expect(a0.seq).toBe(0)
    expect(b0.seq).toBe(0)
    expect(a1.seq).toBe(1)
  })

  it('list returns the turn\'s events in seq order', async () => {
    const s = jsonTraceStore(mkdtempSync(join(tmpdir(), 'tr-')), { now: clock() })
    await s.append('t', { kind: 'thinking', payload: { content: '1' } })
    await s.append('t', { kind: 'text', payload: { content: '2' } })
    const got = await s.list('t')
    expect(got.map((e) => e.seq)).toEqual([0, 1])
    expect(got.map((e) => e.kind)).toEqual(['thinking', 'text'])
  })

  it('list(afterSeq) returns only events strictly after that seq', async () => {
    const s = jsonTraceStore(mkdtempSync(join(tmpdir(), 'tr-')), { now: clock() })
    await s.append('t', { kind: 'thinking', payload: {} }) // 0
    await s.append('t', { kind: 'text', payload: {} })     // 1
    await s.append('t', { kind: 'result', payload: {} })   // 2
    expect((await s.list('t', 0)).map((e) => e.seq)).toEqual([1, 2])
    expect((await s.list('t', 1)).map((e) => e.seq)).toEqual([2])
    expect((await s.list('t', 2)).map((e) => e.seq)).toEqual([])
  })

  it('list scopes to one turn', async () => {
    const s = jsonTraceStore(mkdtempSync(join(tmpdir(), 'tr-')), { now: clock() })
    await s.append('A', { kind: 'text', payload: { content: 'a' } })
    await s.append('B', { kind: 'text', payload: { content: 'b' } })
    expect((await s.list('A')).map((e) => e.payload)).toEqual([{ content: 'a' }])
  })

  it('seq continues from persisted max across a fresh store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tr-'))
    const s1 = jsonTraceStore(dir, { now: clock() })
    await s1.append('t', { kind: 'thinking', payload: {} }) // 0
    const s2 = jsonTraceStore(dir, { now: clock() })
    const e = await s2.append('t', { kind: 'text', payload: {} })
    expect(e.seq).toBe(1)
  })
})
