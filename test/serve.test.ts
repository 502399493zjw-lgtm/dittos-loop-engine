import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { runFlow } from '../src/engine/runtime'
import { jsonLoopStore } from '../src/loop/jsonLoopStore'
import { fakeExecutor } from '../src/executor/fake'
import { agentLoopFlow, buildExecutor, demoFlow, feedbackFlow, flows, seedDemoLoop } from '../src/serve'
import type { EngineEvent } from '../src/types'

describe('serve — demo wiring', () => {
  it('flows registry exposes the demo flow', () => {
    expect(flows.demo).toBe(demoFlow)
  })

  it('flows registry exposes the generic agentLoop flow', () => {
    expect(flows.agentLoop).toBe(agentLoopFlow)
  })

  it('agentLoopFlow runs its instructions as one agent turn', async () => {
    const executor = fakeExecutor() // default: echoes the prompt
    const res = await runFlow(agentLoopFlow, {
      runId: 'al-1', executor, defaultAgent: 'claude',
      args: { instructions: '汇总今天的 GitHub trending 并发我', name: '日报' }, emit: () => {},
    })
    expect(res.status).toBe('completed')
    // The flow embeds the instructions in the agent prompt; the fake echoes it back.
    expect(String(res.result)).toContain('汇总今天的 GitHub trending 并发我')
  })

  it('feedbackFlow runs to completion without an in-flow approval gate', async () => {
    // Per the loop design, no shipped loop flow uses an in-flow approval gate;
    // escalation is handled at the loop level instead. So feedbackFlow must NOT
    // emit approval_requested.
    const executor = fakeExecutor() // default: echoes the prompt
    const events: EngineEvent[] = []
    const res = await runFlow(feedbackFlow, {
      runId: 'fb-1', executor, defaultAgent: 'claude', emit: (e: EngineEvent) => events.push(e),
    })
    expect(res.status).toBe('completed')
    expect(events.some((e) => e.type === 'approval_requested')).toBe(false)
  })

  it('demoFlow returns a deterministic greeting through the fake executor', async () => {
    const executor = buildExecutor() // RUN_REAL unset → fake, keyed to the demo prompt
    const res = await runFlow(demoFlow, { runId: 'serve-1', executor, defaultAgent: 'claude', emit: () => {} })
    expect(res.status).toBe('completed')
    expect(res.result).toContain('Live Loop')
  })

  it('seedDemoLoop creates demo-loop when absent', async () => {
    const store = jsonLoopStore(mkdtempSync(join(tmpdir(), 'serve-')))
    expect(await store.get('demo-loop')).toBeUndefined()
    await seedDemoLoop(store)
    const got = await store.get('demo-loop')
    expect(got?.spec.flow).toBe('demo')
    expect(got?.spec.trigger).toEqual({ kind: 'interval', everyMs: 600000 })
  })

  it('seedDemoLoop does not clobber an existing loop state', async () => {
    const store = jsonLoopStore(mkdtempSync(join(tmpdir(), 'serve-')))
    await store.upsert({ id: 'demo-loop', flow: 'demo', trigger: { kind: 'interval', everyMs: 1234 } })
    await store.setState('demo-loop', { paused: true, consecutiveFailures: 2 })
    await seedDemoLoop(store)
    const got = await store.get('demo-loop')
    // untouched: original trigger + state preserved
    expect(got?.spec.trigger).toEqual({ kind: 'interval', everyMs: 1234 })
    expect(got?.state.paused).toBe(true)
    expect(got?.state.consecutiveFailures).toBe(2)
  })
})
