import { describe, it, expect } from 'vitest'
import { runFlow } from '../src/engine/runtime'
import { fakeExecutor } from '../src/executor/fake'
import { makeIdGen } from '../src/engine/ids'

describe('pipeline', () => {
  it('runs each item through all stages independently; later stages see prev + originalItem + index', async () => {
    const ex = fakeExecutor()
    const out = await runFlow(async (api) =>
      api.pipeline(['x', 'y'],
        async (_prev, item) => `s1:${item}`,
        async (prev, item, i) => `${prev}|s2:${item}#${i}`,
      ), { runId: 'r', executor: ex, defaultAgent: 'claude', emit: () => {}, now: () => 0, nextId: makeIdGen() })
    expect(out.result).toEqual(['s1:x|s2:x#0', 's1:y|s2:y#1'])
  })
  it('an item whose stage throws drops to null and skips its remaining stages', async () => {
    const out = await runFlow(async (api) =>
      api.pipeline(['ok', 'bad'],
        async (_p, item) => { if (item === 'bad') throw new Error('no'); return item },
        async (prev) => `done:${prev}`,
      ), { runId: 'r', executor: ex2(), defaultAgent: 'claude', emit: () => {}, now: () => 0, nextId: makeIdGen() })
    expect(out.result).toEqual(['done:ok', null])
  })
})
function ex2() { return fakeExecutor() }
