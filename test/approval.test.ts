import { describe, it, expect } from 'vitest'
import { runFlow } from '../src/engine/runtime'
import { fakeExecutor } from '../src/executor/fake'
import { makeIdGen } from '../src/engine/ids'
import type { EngineEvent, ApprovalRequest, ApprovalResult } from '../src/types'

function harness(awaitApproval?: (req: ApprovalRequest) => Promise<ApprovalResult>) {
  const events: EngineEvent[] = []
  const ex = fakeExecutor({ replies: {} })
  return { events, ex, deps: { runId: 'r1', executor: ex, defaultAgent: 'claude', emit: (e: EngineEvent) => events.push(e), now: () => 0, nextId: makeIdGen(), awaitApproval } }
}

describe('api.approval', () => {
  it('emits requested then resolved, returns the injected decision', async () => {
    const { events, deps } = harness(async () => ({ decision: 'reject' }))
    const out = await runFlow(async (api) => {
      const r = await api.approval('ship it?', { options: ['approve', 'reject'] })
      return r.decision
    }, deps)
    expect(out).toEqual({ status: 'completed', result: 'reject' })
    const req = events.find((e) => e.type === 'approval_requested') as Extract<EngineEvent, { type: 'approval_requested' }>
    expect(req.prompt).toBe('ship it?')
    expect(req.options).toEqual(['approve', 'reject'])
    const res = events.find((e) => e.type === 'approval_resolved') as Extract<EngineEvent, { type: 'approval_resolved' }>
    expect(res.decision).toBe('reject')
    expect(req.approvalId).toBe(res.approvalId)
    const seq = events.map((e) => e.type)
    expect(seq.indexOf('approval_requested')).toBeLessThan(seq.indexOf('approval_resolved'))
  })

  it('auto-approves to options[0] when no awaitApproval is injected (flows never hang)', async () => {
    const { events, deps } = harness()
    const out = await runFlow(async (api) => {
      const r = await api.approval('ship it?', { options: ['approve', 'reject'] })
      return r.decision
    }, deps)
    expect(out).toEqual({ status: 'completed', result: 'approve' })
    const res = events.find((e) => e.type === 'approval_resolved') as Extract<EngineEvent, { type: 'approval_resolved' }>
    expect(res.decision).toBe('approve')
  })
})
