import { cronMatches, cronNextAfter } from './cron'
import type { TriggerSpec } from './types'

/**
 * Unified trigger evaluation + human description.
 *
 * Works over BOTH shapes the codebase carries on `LoopSpec.trigger`:
 *   - the legacy union: `{ kind:'interval'; everyMs } | { kind:'cron'; expr }`
 *   - the new `TriggerSpec` (adds self-paced/event/condition/manual + a
 *     human `description`).
 *
 * Only `interval` + `cron` ever auto-fire; the scheduler already skips
 * self-paced / manual / event / condition (they re-enter by other means), so
 * `shouldFire`/`nextFireMs` return `false`/`null` for those.
 */
export type AnyTrigger =
  | { kind: 'interval'; everyMs: number; description?: string }
  | { kind: 'cron'; expr: string; description?: string }
  | TriggerSpec

/** Human label for an interval, in 中文 — whole hours render as 小时, else 分钟. */
function intervalLabel(everyMs: number): string {
  if (everyMs % 3_600_000 === 0) return `每 ${everyMs / 3_600_000} 小时`
  return `每 ${everyMs / 60_000} 分钟`
}

/**
 * Human label for a standard 5-field cron expr — ported verbatim from the
 * frontend `cronLabel` so the engine and GUI render identical strings:
 *   "0 9 * * *"     → "每天 9:00"   (daily at HH:00)
 *   "30 8 * * *"    → "每天 8:30"   (daily at HH:MM, minutes zero-padded)
 *   "0 * * * *"     → "每小时"      (top of every hour)
 *   "*\/30 * * * *" → "每 30 分钟"  (every N minutes)
 *   anything else   → "cron: <expr>"
 */
export function cronLabel(expr: string): string {
  const fields = expr.trim().split(/\s+/)
  if (fields.length === 5) {
    const [min, hour, dom, mon, dow] = fields
    const wild = dom === '*' && mon === '*' && dow === '*'
    if (wild) {
      // Top of every hour: "0 * * * *".
      if (min === '0' && hour === '*') return '每小时'
      // Every N minutes: "*/N * * * *".
      const stepMatch = /^\*\/(\d+)$/.exec(min as string)
      if (stepMatch && hour === '*') return `每 ${Number(stepMatch[1])} 分钟`
      // Daily at a fixed time: "M H * * *" with concrete numeric M and H.
      if (/^\d+$/.test(min as string) && /^\d+$/.test(hour as string)) {
        return `每天 ${Number(hour)}:${String(Number(min)).padStart(2, '0')}`
      }
    }
  }
  return `cron: ${expr}`
}

/**
 * Human-readable 中文 description of a trigger.
 *
 * If a `TriggerSpec` already carries a non-empty `description`, it wins (a
 * user-authored string is more meaningful than any generated label). Otherwise
 * the label is derived from the kind.
 */
export function describeTrigger(t: AnyTrigger): string {
  const desc = (t as TriggerSpec).description
  if (typeof desc === 'string' && desc.trim() !== '') return desc

  switch (t.kind) {
    case 'interval':
      return t.everyMs != null ? intervalLabel(t.everyMs) : '手动'
    case 'cron':
      return t.expr != null ? cronLabel(t.expr) : '手动'
    case 'self-paced':
      return '自走(到完成/卡住)'
    case 'manual':
      return '手动'
    case 'event':
      return `事件:${t.condition ?? ''}`
    case 'condition':
      return `条件:${t.condition ?? ''}`
    default:
      return '手动'
  }
}

/** Minute bucket for cron de-dup; an undefined lastRun sorts before any minute. */
function minute(x: number | undefined): number {
  return x == null ? -Infinity : Math.floor(x / 60000)
}

/**
 * Should this trigger fire at time `t` given its last run (ms epoch, or
 * undefined if never)?  Only interval + cron auto-fire:
 *   - interval: once `everyMs` has elapsed since `lastRunMs` (never-run = due).
 *   - cron: when `t` lands in a matching minute, at most once per minute.
 *   - everything else: false (the scheduler re-enters those by other means).
 */
export function shouldFire(t: AnyTrigger, lastRunMs: number | undefined, t0: number): boolean {
  switch (t.kind) {
    case 'interval':
      return t.everyMs != null && t0 - (lastRunMs ?? 0) >= t.everyMs
    case 'cron':
      return t.expr != null && cronMatches(t.expr, new Date(t0)) && minute(lastRunMs) < minute(t0)
    default:
      return false
  }
}

/**
 * The next time (ms epoch) this trigger would fire, or `null` if it never
 * auto-fires (self-paced / manual / event / condition).
 *   - interval: `lastRunMs + everyMs`, or `now` if it has never run.
 *   - cron: the next matching minute strictly after `now`.
 */
export function nextFireMs(t: AnyTrigger, lastRunMs: number | undefined, now: number): number | null {
  switch (t.kind) {
    case 'interval':
      if (t.everyMs == null) return null
      return lastRunMs == null ? now : lastRunMs + t.everyMs
    case 'cron':
      if (t.expr == null) return null
      return cronNextAfter(t.expr, new Date(now)).getTime()
    default:
      return null
  }
}
