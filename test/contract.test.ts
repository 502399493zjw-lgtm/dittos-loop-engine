import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { jsonLoopStore } from '../src/loop/jsonLoopStore'
import type { LoopSpec, ExecutionBody, Step, TriggerSpec } from '../src/loop/types'

const body: ExecutionBody = {
  steps: [
    {
      id: 'phase-1',
      kind: 'phase',
      label: '收集与分析',
      children: [
        { id: 'gather', kind: 'agent', label: '收集反馈', prompt: 'Pull new feedback since the cursor.' },
        {
          id: 'fan-out',
          kind: 'parallel',
          label: '并行分类',
          children: [
            { id: 'classify-a', kind: 'agent', label: '分类 A', prompt: 'Classify bucket A.' },
            { id: 'classify-b', kind: 'agent', label: '分类 B', prompt: 'Classify bucket B.' },
          ],
        },
      ],
    },
    { id: 'report', kind: 'agent', label: '汇报', prompt: 'Summarize and report.' },
  ],
}

const trigger: TriggerSpec = {
  kind: 'cron',
  expr: '0 9 * * *',
  description: '每天 9:00',
}

const fullContract: LoopSpec = {
  id: 'full',
  flow: 'execution-body',
  name: 'Feedback Watch',
  mode: 'project',
  goal: '盯住用户反馈并分类汇报',
  scope: 'feedback inbox only',
  trigger,
  escalation: ['refunds', 'prod-changes'],
  reporting: 'daily digest to the owner',
  stop: 'owner cancels or 30 consecutive empty runs',
  body,
  ownerId: 'owner-1',
  projectId: 'proj-1',
  budgetUsd: 2,
}

describe('LoopContract round-trip through jsonLoopStore', () => {
  it('a full contract (body/mode/escalation/stop) survives upsert -> get -> list', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'contract-'))
    const s = jsonLoopStore(dir)
    await s.upsert(fullContract)

    const got = await s.get('full')
    expect(got?.spec).toEqual(fullContract)
    expect(got?.spec.mode).toBe('project')
    expect(got?.spec.escalation).toEqual(['refunds', 'prod-changes'])
    expect(got?.spec.stop).toBe('owner cancels or 30 consecutive empty runs')
    expect(got?.spec.body?.steps).toHaveLength(2)

    // nested structure preserved (phase -> parallel -> agents)
    const phase = got?.spec.body?.steps[0] as Step
    expect(phase.kind).toBe('phase')
    const parallel = phase.children?.[1] as Step
    expect(parallel.kind).toBe('parallel')
    expect(parallel.children?.map((c) => c.id)).toEqual(['classify-a', 'classify-b'])

    const listed = await s.list('owner-1')
    expect(listed.map((x) => x.spec.id)).toEqual(['full'])
    expect(listed[0]?.spec).toEqual(fullContract)
  })

  it('an old minimal spec (id + flow + trigger only) still loads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'contract-'))
    const s = jsonLoopStore(dir)
    const minimal: LoopSpec = { id: 'min', flow: 'demo', trigger: { kind: 'interval', everyMs: 1000 } }
    await s.upsert(minimal)

    const got = await s.get('min')
    expect(got?.spec).toEqual(minimal)
    expect(got?.spec.mode).toBeUndefined()
    expect(got?.spec.body).toBeUndefined()
    expect(got?.spec.escalation).toBeUndefined()

    const all = await s.list()
    expect(all.map((x) => x.spec.id)).toEqual(['min'])
  })
})
