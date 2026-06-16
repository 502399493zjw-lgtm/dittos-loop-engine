import { describe, it, expect } from 'vitest'
import { runFlow } from '../src/engine/runtime'
import { fakeExecutor } from '../src/executor/fake'
import { makeIdGen } from '../src/engine/ids'
import type { EngineEvent } from '../src/types'

describe('runFlow budget cap', () => {
  it('stops the run failed + emits budget_exceeded once cumulative cost >= cap, no further agent_started', async () => {
    const events: EngineEvent[] = []
    const ex = fakeExecutor({
      replies: {
        'claude:a': { text: 'A', cost: 0.5 },
        'claude:b': { text: 'B', cost: 0.5 },
        'claude:c': { text: 'C', cost: 0.5 },
      },
    })
    const out = await runFlow(
      async (api) => {
        await api.agent('a')
        await api.agent('b')
        await api.agent('c')
      },
      { runId: 'r1', executor: ex, defaultAgent: 'claude', budgetUsd: 0.9, emit: (e) => events.push(e), now: () => 0, nextId: makeIdGen() },
    )

    expect(out.status).toBe('failed')

    const exceeded = events.find((e) => e.type === 'budget_exceeded') as
      | Extract<EngineEvent, { type: 'budget_exceeded' }>
      | undefined
    expect(exceeded).toBeDefined()
    expect(exceeded?.spent).toBe(1.0)
    expect(exceeded?.cap).toBe(0.9)
    expect(exceeded?.runId).toBe('r1')

    // 1st + 2nd agent start; 2nd blows the cap so the 3rd never starts.
    expect(events.filter((e) => e.type === 'agent_started')).toHaveLength(2)
    expect(events.filter((e) => e.type === 'budget_exceeded')).toHaveLength(1)
    expect(ex.calls.map((c) => c.prompt)).toEqual(['a', 'b'])

    const done = events.find((e) => e.type === 'run_done') as Extract<EngineEvent, { type: 'run_done' }>
    expect(done.status).toBe('failed')
  })

  it('no cap when budgetUsd is undefined — all agents run, no budget_exceeded', async () => {
    const events: EngineEvent[] = []
    const ex = fakeExecutor({
      replies: {
        'claude:a': { text: 'A', cost: 0.5 },
        'claude:b': { text: 'B', cost: 0.5 },
        'claude:c': { text: 'C', cost: 0.5 },
      },
    })
    const out = await runFlow(
      async (api) => {
        await api.agent('a')
        await api.agent('b')
        await api.agent('c')
      },
      { runId: 'r2', executor: ex, defaultAgent: 'claude', emit: (e) => events.push(e), now: () => 0, nextId: makeIdGen() },
    )
    expect(out.status).toBe('completed')
    expect(events.filter((e) => e.type === 'agent_started')).toHaveLength(3)
    expect(events.some((e) => e.type === 'budget_exceeded')).toBe(false)
  })
})
