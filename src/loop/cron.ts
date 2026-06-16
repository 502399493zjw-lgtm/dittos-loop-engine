// Self-contained standard 5-field cron matcher (no dependencies).
// Fields: "minute hour day-of-month month day-of-week"
//   minute 0-59, hour 0-23, day-of-month 1-31, month 1-12, day-of-week 0-6 (0=Sun, also accept 7=Sun).
// Per-field syntax: '*', '*/n', 'a', 'a-b', 'a-b/n', and comma lists combining any of the above.
// Numeric only — name aliases (JAN, MON) are out of scope.

interface FieldRange {
  min: number
  max: number
}

const RANGES: FieldRange[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day-of-month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 },  // day-of-week (7 == 0 == Sunday)
]

interface ParsedCron {
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
  domRestricted: boolean
  dowRestricted: boolean
}

function parseInt10(token: string): number {
  if (!/^\d+$/.test(token)) throw new Error(`cron: unparseable number '${token}'`)
  return Number(token)
}

// Parse a single comma-separated field into the set of matching numbers.
function parseField(field: string, range: FieldRange): Set<number> {
  const out = new Set<number>()
  const parts = field.split(',')
  for (const partRaw of parts) {
    const part = partRaw.trim()
    if (part === '') throw new Error('cron: empty field component')

    // Split off an optional step: "<base>/<step>".
    let base = part
    let step = 1
    const slash = part.indexOf('/')
    if (slash !== -1) {
      base = part.slice(0, slash)
      const stepStr = part.slice(slash + 1)
      step = parseInt10(stepStr)
      if (step < 1) throw new Error(`cron: step must be >= 1 in '${part}'`)
    }

    let lo: number
    let hi: number
    if (base === '*') {
      lo = range.min
      hi = range.max
    } else {
      const dash = base.indexOf('-')
      if (dash !== -1) {
        lo = parseInt10(base.slice(0, dash))
        hi = parseInt10(base.slice(dash + 1))
      } else {
        lo = parseInt10(base)
        // A bare single value with a step (e.g. "5/15") scans from the value
        // to the field max — matching standard cron semantics.
        hi = slash !== -1 ? range.max : lo
      }
    }

    if (lo < range.min || hi > range.max || lo > hi) {
      throw new Error(`cron: value out of range in '${part}' (allowed ${range.min}-${range.max})`)
    }

    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}

function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) {
    throw new Error(`cron: expected 5 fields, got ${fields.length} in '${expr}'`)
  }

  const minuteStr = fields[0] as string
  const hourStr = fields[1] as string
  const domStr = fields[2] as string
  const monthStr = fields[3] as string
  const dowStr = fields[4] as string

  const dow = parseField(dowStr, RANGES[4] as FieldRange)
  // Normalize 7 -> 0 (both mean Sunday) so getDay() lookups (0..6) work.
  if (dow.has(7)) {
    dow.delete(7)
    dow.add(0)
  }

  return {
    minute: parseField(minuteStr, RANGES[0] as FieldRange),
    hour: parseField(hourStr, RANGES[1] as FieldRange),
    dom: parseField(domStr, RANGES[2] as FieldRange),
    month: parseField(monthStr, RANGES[3] as FieldRange),
    dow,
    domRestricted: domStr.trim() !== '*',
    dowRestricted: dowStr.trim() !== '*',
  }
}

function matchesParsed(p: ParsedCron, date: Date): boolean {
  if (!p.minute.has(date.getMinutes())) return false
  if (!p.hour.has(date.getHours())) return false
  if (!p.month.has(date.getMonth() + 1)) return false

  const domOk = p.dom.has(date.getDate())
  const dowOk = p.dow.has(date.getDay())

  // DOM/DOW OR-rule: if both are restricted, match when EITHER matches.
  // If only one is restricted, that one must match. '*' always matches.
  if (p.domRestricted && p.dowRestricted) return domOk || dowOk
  if (p.domRestricted) return domOk
  if (p.dowRestricted) return dowOk
  return true
}

export function cronMatches(expr: string, date: Date): boolean {
  return matchesParsed(parseCron(expr), date)
}

const MAX_SCAN_MINUTES = 366 * 24 * 60

export function cronNextAfter(expr: string, from: Date): Date {
  const parsed = parseCron(expr)
  // Start strictly after `from`: zero seconds/ms and step to the next minute.
  const cursor = new Date(from.getTime())
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)

  for (let i = 0; i < MAX_SCAN_MINUTES; i++) {
    if (matchesParsed(parsed, cursor)) return cursor
    cursor.setMinutes(cursor.getMinutes() + 1)
  }
  throw new Error(`cron: no match within ${MAX_SCAN_MINUTES} minutes for '${expr}'`)
}
