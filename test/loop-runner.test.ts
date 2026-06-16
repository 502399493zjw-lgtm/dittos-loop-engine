import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { loopRunner } from '../src/loop/loopRunner'
import { jsonLoopStore } from '../src/loop/jsonLoopStore'
import { fakeExecutor } from '../src/executor/fake'
import { fakeSessionBus } from '../src/loop/sessionBus'
import type { LoopSpec } from '../src/loop/types'
import type { SessionBus } from '../src/loop/sessionBus'
import type { EngineEvent, Flow } from '../src/types'

const spec = (over: Partial<LoopSpec> = {}): LoopSpec => ({
  id: 'L1', flow: 'demo', trigger: { kind: 'interval', everyMs: 1000 }, ...over,
})

interface Captured { kind: 'paused'; reason: 'failures' | 'budget'; detail: string; loopId: string }

function harness(flows: Record<string, Flow>, opts: { sessionBus?: SessionBus } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lr-'))
  const store = jsonLoopStore(dir)
  const events: EngineEvent[] = []
  const notified: Captured[] = []
  const ex = fakeExecutor()
  const runner = loopRunner({
    store,
    executor: ex,
    flows,
    emit: (e: EngineEvent) => events.push(e),
    notify: (loopId, ev) => notified.push({ ...ev, loopId }),
    defaultAgent: 'claude',
    memoryDir: dir,
    sessionBus: opts.sessionBus,
  })
  return { dir, store, events, notified, ex, runner }
}

describe('loopRunner.tick — platform contract', () => {
  it('success advances cursor + resets consecutiveFailures', async () => {
    // a flow that reads the current cursor from args and commits cursor+1
    const flow: Flow = async (api) => {
      const cur = (api.args as { cursor: number }).cursor
      api.commit({ cursor: cur + 1 })
      return 'ok'
    }
    const { store, runner } = harness({ demo: flow })
    await store.upsert(spec())
    await store.setState('L1', { cursor: 41, consecutiveFailures: 2 })

    await runner.tick('L1')

    const got = await store.get('L1')
    expect(got?.state.cursor).toBe(42)
    expect(got?.state.consecutiveFailures).toBe(0)
    expect(got?.state.paused).toBe(false)
    expect(got?.state.lastRunAt).toBeTypeOf('number')
  })

  it('throw increments failures, leaves cursor unchanged, does not pause (below threshold)', async () => {
    const flow: Flow = async (api) => {
      api.commit({ cursor: 999 }) // staged but must NOT persist on throw
      throw new Error('boom')
    }
    const { store, runner, notified } = harness({ demo: flow })
    await store.upsert(spec())
    await store.setState('L1', { cursor: 7 })

    await runner.tick('L1')

    const got = await store.get('L1')
    expect(got?.state.consecutiveFailures).toBe(1)
    expect(got?.state.cursor).toBe(7) // unchanged
    expect(got?.state.paused).toBe(false)
    expect(notified).toHaveLength(0)
  })

  it('3rd consecutive failure pauses + notifies once with reason "failures"', async () => {
    const flow: Flow = async () => { throw new Error('boom') }
    const { store, runner, notified } = harness({ demo: flow })
    await store.upsert(spec())

    await runner.tick('L1')
    await runner.tick('L1')
    let mid = await store.get('L1')
    expect(mid?.state.paused).toBe(false) // not yet
    await runner.tick('L1')

    const got = await store.get('L1')
    expect(got?.state.consecutiveFailures).toBe(3)
    expect(got?.state.paused).toBe(true)
    expect(got?.state.pausedReason).toBe('failures')
    expect(notified).toHaveLength(1)
    expect(notified[0]?.kind).toBe('paused')
    expect(notified[0]?.reason).toBe('failures')
    expect(notified[0]?.loopId).toBe('L1')
  })

  it('honors a custom maxConsecutiveFailures', async () => {
    const flow: Flow = async () => { throw new Error('boom') }
    const { store, runner, notified } = harness({ demo: flow })
    await store.upsert(spec({ maxConsecutiveFailures: 1 }))

    await runner.tick('L1')

    const got = await store.get('L1')
    expect(got?.state.consecutiveFailures).toBe(1)
    expect(got?.state.paused).toBe(true)
    expect(got?.state.pausedReason).toBe('failures')
    expect(notified).toHaveLength(1)
  })

  it('budget blowout pauses immediately + notifies with reason "budget"', async () => {
    const flow: Flow = async (api) => {
      await api.agent('a')
      await api.agent('b')
      return 'ok'
    }
    const dir = mkdtempSync(join(tmpdir(), 'lr-'))
    const store = jsonLoopStore(dir)
    const events: EngineEvent[] = []
    const notified: Captured[] = []
    const ex = fakeExecutor({ replies: { 'claude:a': { text: 'A', cost: 0.5 }, 'claude:b': { text: 'B', cost: 0.5 } } })
    const runner = loopRunner({
      store, executor: ex, flows: { demo: flow },
      emit: (e) => events.push(e), notify: (loopId, ev) => notified.push({ ...ev, loopId }),
      defaultAgent: 'claude', memoryDir: dir,
    })
    await store.upsert(spec({ budgetUsd: 0.9 }))

    await runner.tick('L1')

    const got = await store.get('L1')
    expect(got?.state.paused).toBe(true)
    expect(got?.state.pausedReason).toBe('budget')
    expect(got?.state.consecutiveFailures).toBe(1)
    expect(notified).toHaveLength(1)
    expect(notified[0]?.reason).toBe('budget')
    expect(events.some((e) => e.type === 'budget_exceeded')).toBe(true)
  })

  it('threads the loop spec ownerId into the run so agent() calls route to that owner (daemon-mode)', async () => {
    const flow: Flow = async (api) => { await api.agent('a'); await api.agent('b'); return 'ok' }
    const { store, runner, ex } = harness({ demo: flow })
    await store.upsert(spec({ ownerId: 'owner-7' }))

    await runner.tick('L1')

    expect(ex.calls.length).toBe(2)
    expect(ex.calls.map((c) => c.ownerId)).toEqual(['owner-7', 'owner-7'])
  })

  it('an unowned loop forwards no ownerId (dev / in-process path unaffected)', async () => {
    const flow: Flow = async (api) => { await api.agent('a'); return 'ok' }
    const { store, runner, ex } = harness({ demo: flow })
    await store.upsert(spec())

    await runner.tick('L1')

    expect(ex.calls[0]?.ownerId).toBeUndefined()
  })

  it('paused loop is a no-op (flow never runs)', async () => {
    let ran = false
    const flow: Flow = async () => { ran = true; return 'ok' }
    const { store, runner } = harness({ demo: flow })
    await store.upsert(spec())
    await store.setState('L1', { paused: true, pausedReason: 'failures' })

    await runner.tick('L1')

    expect(ran).toBe(false)
    const got = await store.get('L1')
    // state untouched (no lastRunAt written)
    expect(got?.state.lastRunAt).toBeUndefined()
  })

  it('passes the per-loop memory.md surface into the run (persists across ticks)', async () => {
    const flow: Flow = async (api) => {
      api.memory.append('checked item 1')
      return api.memory.read()
    }
    const { dir, store, runner } = harness({ demo: flow })
    await store.upsert(spec())

    await runner.tick('L1')
    // run again — memory should persist across runs (ratchet surface)
    await runner.tick('L1')

    const got = await store.get('L1')
    expect(got?.state.consecutiveFailures).toBe(0)
    // memory file under memoryDir/<loopId>.md accumulates across ticks
    const { readFileSync } = await import('node:fs')
    const text = readFileSync(join(dir, 'L1.md'), 'utf8')
    expect(text).toBe('checked item 1\nchecked item 1\n')
  })

  it('an unknown flow key throws (misconfigured loop surfaces loudly)', async () => {
    const { store, runner } = harness({})
    await store.upsert(spec({ flow: 'missing' }))
    await expect(runner.tick('L1')).rejects.toThrow(/missing/)
  })

  it('runs a loop inside a fresh session and mirrors narration', async () => {
    const bus = fakeSessionBus()
    const flow: Flow = async (api) => { api.log('working'); return 'done' }
    const { store, runner } = harness({ f: flow }, { sessionBus: bus })
    await store.upsert(spec({ id: 'L', flow: 'f', projectId: 'proj-1' }))

    await runner.tick('L', { kind: 'manual' })

    const created = bus.calls.find((c) => c.kind === 'create')
    expect(created).toMatchObject({ kind: 'create', projectId: 'proj-1' })
    const posts = bus.calls.filter((c) => c.kind === 'post').map((c) => (c as { text: string }).text)
    expect(posts.some((t) => t.includes('你手动触发'))).toBe(true) // kickoff
    expect(posts.some((t) => t.includes('working'))).toBe(true)    // mirrored log

    // state still ratchets
    const got = await store.get('L')
    expect(got?.state.consecutiveFailures).toBe(0)
    expect(got?.state.paused).toBe(false)
    expect(got?.state.lastRunAt).toBeTypeOf('number')
  })
})
