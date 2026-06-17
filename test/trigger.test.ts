import { describe, it, expect } from 'vitest'
import { describeTrigger, shouldFire, nextFireMs, cronLabel } from '../src/loop/trigger'

describe('describeTrigger — human-readable 中文', () => {
  it('interval everyMs → 每 N 分钟 / 每 N 小时', () => {
    expect(describeTrigger({ kind: 'interval', everyMs: 5 * 60_000 })).toBe('每 5 分钟')
    expect(describeTrigger({ kind: 'interval', everyMs: 30 * 60_000 })).toBe('每 30 分钟')
    expect(describeTrigger({ kind: 'interval', everyMs: 2 * 3_600_000 })).toBe('每 2 小时')
    expect(describeTrigger({ kind: 'interval', everyMs: 3_600_000 })).toBe('每 1 小时')
  })

  it('cron expr → reused cron中文 mapping', () => {
    expect(describeTrigger({ kind: 'cron', expr: '0 9 * * *' })).toBe('每天 9:00')
    expect(describeTrigger({ kind: 'cron', expr: '30 8 * * *' })).toBe('每天 8:30')
    expect(describeTrigger({ kind: 'cron', expr: '0 * * * *' })).toBe('每小时')
    expect(describeTrigger({ kind: 'cron', expr: '*/30 * * * *' })).toBe('每 30 分钟')
    expect(describeTrigger({ kind: 'cron', expr: '15 3 * * 1' })).toBe('cron: 15 3 * * 1')
  })

  it('self-paced / manual / event / condition', () => {
    expect(describeTrigger({ kind: 'self-paced', description: '' })).toBe('自走(到完成/卡住)')
    expect(describeTrigger({ kind: 'manual', description: '' })).toBe('手动')
    expect(describeTrigger({ kind: 'event', condition: 'CI 通过', description: '' })).toBe('事件:CI 通过')
    expect(describeTrigger({ kind: 'condition', condition: 'PR 合并', description: '' })).toBe('条件:PR 合并')
  })

  it('a non-empty TriggerSpec description is returned as-is', () => {
    expect(describeTrigger({ kind: 'cron', expr: '0 9 * * *', description: '工作日早上同步' }))
      .toBe('工作日早上同步')
    expect(describeTrigger({ kind: 'interval', everyMs: 60_000, description: '体检' })).toBe('体检')
  })

  it('legacy union (no description field) still describes', () => {
    expect(describeTrigger({ kind: 'interval', everyMs: 10 * 60_000 } as any)).toBe('每 10 分钟')
    expect(describeTrigger({ kind: 'cron', expr: '0 9 * * *' } as any)).toBe('每天 9:00')
  })
})

describe('cronLabel — ported from the frontend mapping', () => {
  it('common shapes → 中文', () => {
    expect(cronLabel('0 9 * * *')).toBe('每天 9:00')
    expect(cronLabel('30 8 * * *')).toBe('每天 8:30')
    expect(cronLabel('0 * * * *')).toBe('每小时')
    expect(cronLabel('*/30 * * * *')).toBe('每 30 分钟')
  })
  it('anything else → cron: <expr>', () => {
    expect(cronLabel('15 3 * * 1')).toBe('cron: 15 3 * * 1')
    expect(cronLabel('not a cron')).toBe('cron: not a cron')
  })
})

describe('shouldFire — interval & cron only', () => {
  it('interval fires once everyMs has elapsed', () => {
    const t = new Date(2026, 5, 17, 10, 0).getTime()
    // last run was everyMs ago → due
    expect(shouldFire({ kind: 'interval', everyMs: 5 * 60_000 }, t - 5 * 60_000, t)).toBe(true)
    expect(shouldFire({ kind: 'interval', everyMs: 5 * 60_000 }, t - 4 * 60_000, t)).toBe(false)
    // never run yet → due
    expect(shouldFire({ kind: 'interval', everyMs: 5 * 60_000 }, undefined, t)).toBe(true)
  })

  it('cron fires in a matching minute, at most once per minute', () => {
    const at0900 = new Date(2026, 5, 17, 9, 0).getTime()
    const at0901 = new Date(2026, 5, 17, 9, 1).getTime()
    expect(shouldFire({ kind: 'cron', expr: '0 9 * * *' }, undefined, at0900)).toBe(true)
    // already ran this minute → not again
    expect(shouldFire({ kind: 'cron', expr: '0 9 * * *' }, at0900, at0900)).toBe(false)
    // non-matching minute
    expect(shouldFire({ kind: 'cron', expr: '0 9 * * *' }, undefined, at0901)).toBe(false)
  })

  it('self-paced / manual / event / condition never auto-fire', () => {
    const t = Date.now()
    expect(shouldFire({ kind: 'self-paced', description: '' }, undefined, t)).toBe(false)
    expect(shouldFire({ kind: 'manual', description: '' }, undefined, t)).toBe(false)
    expect(shouldFire({ kind: 'event', condition: 'x', description: '' }, undefined, t)).toBe(false)
    expect(shouldFire({ kind: 'condition', condition: 'x', description: '' }, undefined, t)).toBe(false)
  })
})

describe('nextFireMs — interval & cron only', () => {
  it('interval → lastRun + everyMs (or now when never run)', () => {
    const t = new Date(2026, 5, 17, 10, 0).getTime()
    expect(nextFireMs({ kind: 'interval', everyMs: 5 * 60_000 }, t, t)).toBe(t + 5 * 60_000)
    expect(nextFireMs({ kind: 'interval', everyMs: 5 * 60_000 }, undefined, t)).toBe(t)
  })

  it('cron → the next matching minute strictly after now', () => {
    const at0830 = new Date(2026, 5, 17, 8, 30).getTime()
    const next = nextFireMs({ kind: 'cron', expr: '0 9 * * *' }, undefined, at0830)
    expect(next).toBe(new Date(2026, 5, 17, 9, 0).getTime())
  })

  it('self-paced / manual / event / condition → null (never auto-fire)', () => {
    const t = Date.now()
    expect(nextFireMs({ kind: 'self-paced', description: '' }, undefined, t)).toBeNull()
    expect(nextFireMs({ kind: 'manual', description: '' }, undefined, t)).toBeNull()
    expect(nextFireMs({ kind: 'event', condition: 'x', description: '' }, undefined, t)).toBeNull()
    expect(nextFireMs({ kind: 'condition', condition: 'x', description: '' }, undefined, t)).toBeNull()
  })
})
