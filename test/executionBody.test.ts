import { describe, it, expect } from 'vitest'
import { runFlow } from '../src/engine/runtime'
import { fakeExecutor } from '../src/executor/fake'
import { makeIdGen } from '../src/engine/ids'
import { runBody } from '../src/loop/executionBody'
import type { EngineEvent } from '../src/types'
import type { ExecutionBody } from '../src/loop/types'

function body(): ExecutionBody {
  return {
    steps: [
      { id: 's1', kind: 'phase', label: '扫描' },
      { id: 's2', kind: 'agent', label: '归类', prompt: '归类' },
      {
        id: 's3',
        kind: 'parallel',
        label: '并行',
        children: [
          { id: 's3a', kind: 'agent', label: 'A', prompt: 'A' },
          { id: 's3b', kind: 'agent', label: 'B', prompt: 'B' },
        ],
      },
    ],
  }
}

describe('runBody', () => {
  it('walks a structured body onto the engine primitives, emits the right events, returns step results', async () => {
    const events: EngineEvent[] = []
    const ex = fakeExecutor({
      replies: { 'claude:归类': { text: 'sorted' }, 'claude:A': { text: 'a-done' }, 'claude:B': { text: 'b-done' } },
    })
    let results: unknown[] = []
    const out = await runFlow(async (api) => {
      results = await runBody(body(), api)
      return 'ok'
    }, { runId: 'r1', executor: ex, defaultAgent: 'claude', emit: (e) => events.push(e), now: () => 0, nextId: makeIdGen() })

    expect(out.status).toBe('completed')

    // phase_started("扫描")
    const phase = events.find((e) => e.type === 'phase_started') as Extract<EngineEvent, { type: 'phase_started' }>
    expect(phase?.title).toBe('扫描')

    // agent_started for 归类 / A / B
    const startedLabels = events
      .filter((e): e is Extract<EngineEvent, { type: 'agent_started' }> => e.type === 'agent_started')
      .map((e) => e.label)
    expect(startedLabels).toContain('归类')
    expect(startedLabels).toContain('A')
    expect(startedLabels).toContain('B')

    // agent_done for all three agents, all ok
    const done = events.filter((e): e is Extract<EngineEvent, { type: 'agent_done' }> => e.type === 'agent_done')
    expect(done).toHaveLength(3)
    expect(done.every((e) => e.status === 'ok')).toBe(true)

    // runBody returns the collected step results in order:
    // phase -> undefined, agent 归类 -> 'sorted', parallel -> ['a-done', 'b-done']
    expect(results).toEqual([undefined, 'sorted', ['a-done', 'b-done']])
  })
})
