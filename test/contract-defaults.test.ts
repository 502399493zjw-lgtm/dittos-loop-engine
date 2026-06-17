import { describe, it, expect } from 'vitest'
import { compileDefaults, validateContract } from '../src/loop/contract'
import type { LoopSpec, TriggerSpec } from '../src/loop/types'

describe('compileDefaults', () => {
  it('fills a mandatory stop rule when missing', () => {
    const spec = compileDefaults({ id: 'a', flow: 'demo' })
    expect(spec.stop).toBeTruthy()
    expect(spec.stop).toContain('cancel')
  })

  it('keeps an explicit stop rule untouched', () => {
    const spec = compileDefaults({ id: 'a', flow: 'demo', stop: '30 empty runs' })
    expect(spec.stop).toBe('30 empty runs')
  })

  it('defaults mode to "one-shot" when there is no trigger, and leaves trigger undefined', () => {
    const spec = compileDefaults({ id: 'a', flow: 'demo' })
    expect(spec.mode).toBe('one-shot')
    expect(spec.trigger).toBeUndefined()
  })

  it('defaults mode to "live" when a trigger is present', () => {
    const trigger: TriggerSpec = { kind: 'cron', expr: '0 9 * * *', description: '每天 9:00' }
    const spec = compileDefaults({ id: 'a', flow: 'demo', trigger })
    expect(spec.mode).toBe('live')
    expect(spec.trigger).toEqual(trigger)
  })

  it('respects an explicitly provided mode', () => {
    const spec = compileDefaults({ id: 'a', flow: 'demo', mode: 'project' })
    expect(spec.mode).toBe('project')
  })

  it('always returns a contract that passes validation', () => {
    const spec = compileDefaults({ id: 'a', flow: 'demo' })
    expect(() => validateContract(spec)).not.toThrow()
  })
})

describe('validateContract', () => {
  it('throws when there is no stop rule', () => {
    const spec: LoopSpec = { id: 'a', flow: 'demo' }
    expect(() => validateContract(spec)).toThrow()
  })

  it('throws when the stop rule is empty/whitespace', () => {
    const spec: LoopSpec = { id: 'a', flow: 'demo', stop: '   ' }
    expect(() => validateContract(spec)).toThrow()
  })

  it('does not throw when a stop rule is present', () => {
    const spec: LoopSpec = { id: 'a', flow: 'demo', stop: 'user cancels' }
    expect(() => validateContract(spec)).not.toThrow()
  })
})
