import { describe, it, expect } from 'vitest'
import { runFlow } from '../src/engine/runtime'
import { fakeExecutor } from '../src/executor/fake'
import { makeIdGen } from '../src/engine/ids'
import type { EngineEvent } from '../src/types'

describe('parallel', () => {
  it('runs thunks concurrently, returns all results, nulls a failed thunk', async () => {
    const events: EngineEvent[] = []
    const ex = fakeExecutor({ replies: { 'claude:a': { text: 'A' }, 'claude:b': { error: 'x' }, 'claude:c': { text: 'C' } } })
    const out = await runFlow(async (api) => {
      api.phase('fan')
      return api.parallel([() => api.agent('a'), () => api.agent('b'), () => api.agent('c')])
    }, { runId: 'r', executor: ex, defaultAgent: 'claude', emit: (e) => events.push(e), now: () => 0, nextId: makeIdGen() })
    expect(out.result).toEqual(['A', null, 'C'])
    expect(events.filter((e) => e.type === 'agent_started')).toHaveLength(3)
  })
})
