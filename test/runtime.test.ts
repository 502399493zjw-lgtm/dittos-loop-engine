import { describe, it, expect } from 'vitest'
import { runFlow } from '../src/engine/runtime'
import { fakeExecutor } from '../src/executor/fake'
import { makeIdGen } from '../src/engine/ids'
import type { EngineEvent } from '../src/types'

function harness() {
  const events: EngineEvent[] = []
  const ex = fakeExecutor({ replies: { 'claude:scan': { text: 'found 3' }, 'claude:sum': { text: 'summary' } } })
  return { events, ex, deps: { runId: 'r1', executor: ex, defaultAgent: 'claude', emit: (e: EngineEvent) => events.push(e), now: () => 0, nextId: makeIdGen() } }
}

describe('runFlow', () => {
  it('runs a phase with two sequential agents, emits an ordered tree, returns result', async () => {
    const { events, ex, deps } = harness()
    const out = await runFlow(async (api) => {
      api.phase('扫描')
      const a = await api.agent('scan')
      const b = await api.agent('sum')
      return `${a}|${b}`
    }, deps)
    expect(out).toEqual({ status: 'completed', result: 'found 3|summary' })
    expect(events.map((e) => e.type)).toEqual([
      'run_started', 'phase_started', 'agent_started', 'agent_done', 'agent_started', 'agent_done', 'run_done',
    ])
    expect(ex.calls.map((c) => c.agentId)).toEqual(['claude', 'claude'])
  })

  it('agent({agent}) overrides the default agent', async () => {
    const { ex, deps } = harness()
    await runFlow(async (api) => { await api.agent('scan', { agent: 'codex' }) }, deps)
    expect(ex.calls[0].agentId).toBe('codex')
  })

  it('a thrown error → run_done failed, error surfaced (not swallowed)', async () => {
    const { events, deps } = harness()
    const out = await runFlow(async () => { throw new Error('boom') }, deps)
    expect(out.status).toBe('failed')
    const done = events.find((e) => e.type === 'run_done') as Extract<EngineEvent, { type: 'run_done' }>
    expect(done.status).toBe('failed')
  })

  it('an executor failure → agent_done failed with error', async () => {
    const events: EngineEvent[] = []
    const ex = fakeExecutor({ replies: { 'claude:x': { error: 'spawn fail' } } })
    await runFlow(async (api) => { await api.agent('x') }, {
      runId: 'r', executor: ex, defaultAgent: 'claude', emit: (e) => events.push(e), now: () => 0, nextId: makeIdGen(),
    }).catch(() => {})
    const ad = events.find((e) => e.type === 'agent_done') as Extract<EngineEvent, { type: 'agent_done' }>
    expect(ad.status).toBe('failed'); expect(ad.error).toContain('spawn fail')
  })
})
