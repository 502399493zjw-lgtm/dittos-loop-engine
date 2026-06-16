import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { runFlow } from '../src/engine/runtime'
import { jsonLoopStore } from '../src/loop/jsonLoopStore'
import { buildExecutor, demoFlow, flows, seedDemoLoop } from '../src/serve'

describe('serve — demo wiring', () => {
  it('flows registry exposes the demo flow', () => {
    expect(flows.demo).toBe(demoFlow)
  })

  it('demoFlow returns a deterministic greeting through the fake executor', async () => {
    const executor = buildExecutor() // RUN_REAL unset → fake, keyed to the demo prompt
    const res = await runFlow(demoFlow, { runId: 'serve-1', executor, defaultAgent: 'claude', emit: () => {} })
    expect(res.status).toBe('completed')
    expect(res.result).toContain('Loop Flow')
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
    expect(got?.spec.trigger.everyMs).toBe(1234)
    expect(got?.state.paused).toBe(true)
    expect(got?.state.consecutiveFailures).toBe(2)
  })
})
