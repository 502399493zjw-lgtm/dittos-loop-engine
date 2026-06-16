import { describe, it, expect } from 'vitest'
import { runFlow } from '../src/engine/runtime'
import { fakeExecutor } from '../src/executor/fake'
import { makeIdGen } from '../src/engine/ids'
import type { EngineEvent } from '../src/types'

function deps(extra: Partial<Parameters<typeof runFlow>[1]> = {}) {
  const events: EngineEvent[] = []
  const ex = fakeExecutor({ replies: { 'claude:scan': { text: 'ok' } } })
  return {
    events,
    ex,
    d: {
      runId: 'r1',
      executor: ex,
      defaultAgent: 'claude',
      emit: (e: EngineEvent) => events.push(e),
      now: () => 0,
      nextId: makeIdGen(),
      ...extra,
    },
  }
}

describe('runFlow cursor commit', () => {
  it('returns the committed cursor on success', async () => {
    const { d } = deps()
    const out = await runFlow(async (api) => {
      api.commit({ cursor: 7 })
      return 'done'
    }, d)
    expect(out).toEqual({ status: 'completed', result: 'done', cursor: 7 })
  })

  it('does NOT return a cursor when the flow never commits', async () => {
    const { d } = deps()
    const out = await runFlow(async () => 'done', d)
    expect(out).toEqual({ status: 'completed', result: 'done' })
    expect('cursor' in out).toBe(false)
  })

  it('does NOT return the committed cursor when the run throws', async () => {
    const { d } = deps()
    const out = await runFlow(async (api) => {
      api.commit({ cursor: 99 })
      throw new Error('boom')
    }, d)
    expect(out.status).toBe('failed')
    expect('cursor' in out).toBe(false)
  })

  it('last commit wins; later commits merge over earlier ones', async () => {
    const { d } = deps()
    const out = await runFlow(async (api) => {
      api.commit({ cursor: 1 })
      api.commit({ cursor: 2 })
      return 'done'
    }, d)
    expect(out).toEqual({ status: 'completed', result: 'done', cursor: 2 })
  })
})

describe('runFlow memory surface', () => {
  it('exposes deps.memory to the flow via api.memory', async () => {
    const lines: string[] = []
    const memory = { read: () => lines.join('\n'), append: (l: string) => { lines.push(l) } }
    const { d } = deps({ memory })
    await runFlow(async (api) => {
      api.memory.append('first')
      api.memory.append('second')
      return api.memory.read()
    }, d)
    expect(lines).toEqual(['first', 'second'])
  })

  it('defaults to a noop in-memory store when deps.memory is absent', async () => {
    const { d } = deps()
    const out = await runFlow(async (api) => {
      api.memory.append('x')
      return api.memory.read()
    }, d)
    // noop memory: append accepted, read echoes what was appended in-process
    expect(out.status).toBe('completed')
    expect(typeof out.result).toBe('string')
  })
})
