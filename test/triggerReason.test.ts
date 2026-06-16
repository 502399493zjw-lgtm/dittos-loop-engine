import { describe, it, expect } from 'vitest'
import { describeTrigger } from '../src/loop/triggerReason'

describe('describeTrigger', () => {
  it('manual cause wins regardless of trigger', () => {
    expect(describeTrigger({ kind: 'interval', everyMs: 60000 }, { kind: 'manual' })).toBe('你手动触发')
  })
  it('interval schedule', () => {
    expect(describeTrigger({ kind: 'interval', everyMs: 600000 }, { kind: 'schedule' })).toContain('定时')
  })
  it('cron schedule includes the expr', () => {
    expect(describeTrigger({ kind: 'cron', expr: '0 9 * * *' }, { kind: 'schedule' })).toContain('0 9 * * *')
  })
})
