import { describe, it, expect } from 'vitest'
import { cronMatches, cronNextAfter } from '../src/loop/cron'

describe('cronMatches — wildcards and steps', () => {
  it("'* * * * *' matches anything", () => {
    expect(cronMatches('* * * * *', new Date(2026, 5, 16, 9, 37))).toBe(true)
    expect(cronMatches('* * * * *', new Date(2026, 0, 1, 0, 0))).toBe(true)
    expect(cronMatches('* * * * *', new Date(2026, 11, 31, 23, 59))).toBe(true)
  })

  it("'*/15 * * * *' matches minutes 0/15/30/45 only", () => {
    for (let m = 0; m < 60; m++) {
      const want = m % 15 === 0
      expect(cronMatches('*/15 * * * *', new Date(2026, 5, 16, 10, m))).toBe(want)
    }
  })

  it("'0 9 * * *' matches 09:00 only", () => {
    expect(cronMatches('0 9 * * *', new Date(2026, 5, 16, 9, 0))).toBe(true)
    expect(cronMatches('0 9 * * *', new Date(2026, 5, 16, 9, 1))).toBe(false)
    expect(cronMatches('0 9 * * *', new Date(2026, 5, 16, 10, 0))).toBe(false)
  })

  it("'0 0 1 * *' matches first-of-month midnight", () => {
    expect(cronMatches('0 0 1 * *', new Date(2026, 5, 1, 0, 0))).toBe(true)
    expect(cronMatches('0 0 1 * *', new Date(2026, 5, 2, 0, 0))).toBe(false)
    expect(cronMatches('0 0 1 * *', new Date(2026, 5, 1, 0, 1))).toBe(false)
  })

  it("'0 0 * * 1' matches Mondays at midnight", () => {
    // 2026-06-15 is a Monday
    expect(cronMatches('0 0 * * 1', new Date(2026, 5, 15, 0, 0))).toBe(true)
    // 2026-06-16 is a Tuesday
    expect(cronMatches('0 0 * * 1', new Date(2026, 5, 16, 0, 0))).toBe(false)
  })
})

describe('cronMatches — DOM/DOW OR-rule', () => {
  it("'0 0 13 * 5' matches the 13th OR any Friday", () => {
    // 2026-06-13 is a Saturday — matches via day-of-month
    expect(cronMatches('0 0 13 * 5', new Date(2026, 5, 13, 0, 0))).toBe(true)
    // 2026-06-19 is a Friday but not the 13th — matches via day-of-week
    expect(cronMatches('0 0 13 * 5', new Date(2026, 5, 19, 0, 0))).toBe(true)
    // 2026-06-16 is a Tuesday and not the 13th — matches neither
    expect(cronMatches('0 0 13 * 5', new Date(2026, 5, 16, 0, 0))).toBe(false)
  })

  it('when only DOM is restricted, DOM must match', () => {
    expect(cronMatches('0 0 13 * *', new Date(2026, 5, 13, 0, 0))).toBe(true)
    expect(cronMatches('0 0 13 * *', new Date(2026, 5, 19, 0, 0))).toBe(false)
  })

  it('when only DOW is restricted, DOW must match', () => {
    // any 13th that is not a Friday should NOT match a DOW-only Friday rule
    expect(cronMatches('0 0 * * 5', new Date(2026, 5, 13, 0, 0))).toBe(false)
    expect(cronMatches('0 0 * * 5', new Date(2026, 5, 19, 0, 0))).toBe(true)
  })
})

describe('cronMatches — ranges, lists, steps-in-range', () => {
  it("range '0 9-17 * * *' matches hours 9..17 only", () => {
    for (let h = 0; h < 24; h++) {
      const want = h >= 9 && h <= 17
      expect(cronMatches('0 9-17 * * *', new Date(2026, 5, 16, h, 0))).toBe(want)
    }
  })

  it("list '0 9,12,15 * * *' matches 9, 12, 15 only", () => {
    for (let h = 0; h < 24; h++) {
      const want = h === 9 || h === 12 || h === 15
      expect(cronMatches('0 9,12,15 * * *', new Date(2026, 5, 16, h, 0))).toBe(want)
    }
  })

  it("step-in-range '0 0-12/3 * * *' matches 0, 3, 6, 9, 12 only", () => {
    const hits = new Set([0, 3, 6, 9, 12])
    for (let h = 0; h < 24; h++) {
      expect(cronMatches('0 0-12/3 * * *', new Date(2026, 5, 16, h, 0))).toBe(hits.has(h))
    }
  })

  it('accepts 7 as Sunday in DOW', () => {
    // 2026-06-14 is a Sunday
    expect(cronMatches('0 0 * * 7', new Date(2026, 5, 14, 0, 0))).toBe(true)
    expect(cronMatches('0 0 * * 0', new Date(2026, 5, 14, 0, 0))).toBe(true)
    expect(cronMatches('0 0 * * 7', new Date(2026, 5, 15, 0, 0))).toBe(false)
  })
})

describe('cronNextAfter — boundary crossing', () => {
  it('returns the next minute-aligned match strictly after `from`', () => {
    const next = cronNextAfter('* * * * *', new Date(2026, 5, 16, 9, 37, 42, 123))
    expect(next).toEqual(new Date(2026, 5, 16, 9, 38, 0, 0))
  })

  it('is strictly after `from` even when `from` itself matches', () => {
    const next = cronNextAfter('0 9 * * *', new Date(2026, 5, 16, 9, 0, 0, 0))
    expect(next).toEqual(new Date(2026, 5, 17, 9, 0, 0, 0))
  })

  it('crosses an hour boundary', () => {
    // hourly at minute 0, starting at 09:30 -> 10:00
    const next = cronNextAfter('0 * * * *', new Date(2026, 5, 16, 9, 30))
    expect(next).toEqual(new Date(2026, 5, 16, 10, 0, 0, 0))
  })

  it('crosses a day boundary', () => {
    // daily at 09:00, starting at 10:00 same day -> next day 09:00
    const next = cronNextAfter('0 9 * * *', new Date(2026, 5, 16, 10, 0))
    expect(next).toEqual(new Date(2026, 5, 17, 9, 0, 0, 0))
  })

  it('crosses a month boundary', () => {
    // first-of-month midnight, starting mid-June -> 1 July 00:00
    const next = cronNextAfter('0 0 1 * *', new Date(2026, 5, 16, 12, 0))
    expect(next).toEqual(new Date(2026, 6, 1, 0, 0, 0, 0))
  })
})

describe('cron — invalid expressions throw', () => {
  it("throws on wrong field count ('* * * *' — 4 fields)", () => {
    expect(() => cronMatches('* * * *', new Date(2026, 5, 16, 9, 0))).toThrow()
  })

  it("throws on out-of-range number ('60 * * * *')", () => {
    expect(() => cronMatches('60 * * * *', new Date(2026, 5, 16, 9, 0))).toThrow()
  })

  it('throws on an unparseable token', () => {
    expect(() => cronMatches('xx * * * *', new Date(2026, 5, 16, 9, 0))).toThrow()
  })

  it('cronNextAfter also throws on invalid expressions', () => {
    expect(() => cronNextAfter('60 * * * *', new Date(2026, 5, 16, 9, 0))).toThrow()
  })
})
