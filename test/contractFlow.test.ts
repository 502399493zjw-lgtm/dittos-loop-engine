import { describe, it, expect } from 'vitest'
import { runFlow } from '../src/engine/runtime'
import { makeIdGen } from '../src/engine/ids'
import { contractFlow } from '../src/serve'
import type { Executor, EngineEvent } from '../src/types'
import type { LoopSpec, ExecutionBody } from '../src/loop/types'

/** A 2-step stored body: scan(agent) → reply(agent). */
function storedBody(): ExecutionBody {
  return {
    steps: [
      { id: 's1', kind: 'agent', label: '扫描', prompt: '扫描本轮的新反馈' },
      { id: 's2', kind: 'agent', label: '回复', prompt: '为反馈起草回复' },
    ],
  }
}

/** A CHANGED 2-step body the planner returns when it adapts. */
function adaptedBody(): ExecutionBody {
  return {
    steps: [
      { id: 'a1', kind: 'agent', label: '复盘', prompt: '复盘上一轮遗留问题' },
      { id: 'a2', kind: 'agent', label: '升级', prompt: '升级未解决项' },
    ],
  }
}

/**
 * An executor that returns a fixed JSON for the PLAN step (its prompt contains
 * the "请返回" plan marker) and echoes everything else. Lets us drive the乙
 * plan/adapt decision deterministically without keying on the full prompt string.
 */
function planningExecutor(planReply: string): Executor & { calls: { prompt: string }[] } {
  const calls: { prompt: string }[] = []
  return {
    calls,
    async run(req) {
      calls.push({ prompt: req.prompt })
      if (req.prompt.includes('请返回"这一轮"要执行的剧本')) return { text: planReply, cost: 0 }
      return { text: `echo:${req.prompt}`, cost: 0 }
    },
  }
}

function run(spec: LoopSpec, executor: Executor) {
  const events: EngineEvent[] = []
  return runFlow(contractFlow, {
    runId: 'r1',
    executor,
    defaultAgent: 'claude',
    args: { contract: spec, reason: '定时触发' },
    emit: (e) => events.push(e),
    now: () => 0,
    nextId: makeIdGen(),
  }).then((out) => ({ out, events }))
}

const spec = (over: Partial<LoopSpec> = {}): LoopSpec => ({
  id: 'L1',
  flow: 'contract',
  body: storedBody(),
  ...over,
})

describe('contractFlow (乙 per-tick plan/adapt)', () => {
  it('plan returns the stored body unchanged → adapted=false, the stored steps run', async () => {
    // planner echoes the stored body verbatim
    const ex = planningExecutor(JSON.stringify(storedBody()))
    const { out, events } = await run(spec(), ex)

    expect((out.result as { adapted: boolean }).adapted).toBe(false)
    expect((out.result as { body: ExecutionBody }).body).toEqual(storedBody())

    // the STORED steps ran (扫描 + 回复), not the adapted ones
    const ranLabels = events
      .filter((e): e is Extract<EngineEvent, { type: 'agent_started' }> => e.type === 'agent_started')
      .map((e) => e.label)
    expect(ranLabels).toContain('扫描')
    expect(ranLabels).toContain('回复')
    expect(ranLabels).not.toContain('复盘')
  })

  it('plan returns a CHANGED body → adapted=true, the changed steps run', async () => {
    const ex = planningExecutor(JSON.stringify(adaptedBody()))
    const { out, events } = await run(spec(), ex)

    expect((out.result as { adapted: boolean }).adapted).toBe(true)
    expect((out.result as { body: ExecutionBody }).body).toEqual(adaptedBody())

    const ranLabels = events
      .filter((e): e is Extract<EngineEvent, { type: 'agent_started' }> => e.type === 'agent_started')
      .map((e) => e.label)
    // adapted steps ran; original stored steps did NOT
    expect(ranLabels).toContain('复盘')
    expect(ranLabels).toContain('升级')
    expect(ranLabels).not.toContain('扫描')
  })

  it('plan returns extra prose around the JSON → still parses + runs the plan', async () => {
    const ex = planningExecutor(`好的，调整如下：\n${JSON.stringify(adaptedBody())}\n以上。`)
    const { out } = await run(spec(), ex)
    expect((out.result as { adapted: boolean }).adapted).toBe(true)
    expect((out.result as { body: ExecutionBody }).body).toEqual(adaptedBody())
  })

  it('unparseable plan → falls back to the stored body (adapted=false)', async () => {
    const ex = planningExecutor('抱歉无法决定')
    const { out } = await run(spec(), ex)
    expect((out.result as { adapted: boolean }).adapted).toBe(false)
    expect((out.result as { body: ExecutionBody }).body).toEqual(storedBody())
  })

  it('escalation boundaries are threaded into the agent prompts', async () => {
    const ex = planningExecutor(JSON.stringify(storedBody()))
    const { events } = await run(spec({ escalation: ['退款', '生产环境'] }), ex)
    // the plan prompt carries the escalation preamble
    const planStarted = events.find(
      (e): e is Extract<EngineEvent, { type: 'agent_started' }> =>
        e.type === 'agent_started' && e.prompt.includes('请返回"这一轮"要执行的剧本'),
    )
    expect(planStarted?.prompt).toContain('升级边界')
    expect(planStarted?.prompt).toContain('退款')
    expect(planStarted?.prompt).toContain('生产环境')
  })

  it('no stored body → legacy fallback: one agent call from instructions', async () => {
    const ex = planningExecutor('unused')
    const { out, events } = await run(
      { id: 'L1', flow: 'contract', instructions: '盘点库存' },
      ex,
    )
    const started = events.filter(
      (e): e is Extract<EngineEvent, { type: 'agent_started' }> => e.type === 'agent_started',
    )
    expect(started).toHaveLength(1)
    expect(started[0]?.prompt).toContain('盘点库存')
    expect(typeof out.result).toBe('string')
  })
})
