import { cronMatches } from './cron'
import type { LoopRunner } from './loopRunner'
import type { LoopSpec, LoopState, LoopStore } from './types'

export interface LoopSchedulerDeps {
  store: LoopStore
  runner: LoopRunner
  /** how often the scheduler wakes up to look for due loops */
  tickMs: number
  /** injectable clock for deterministic tests */
  now?: () => number
}

export interface LoopScheduler {
  start(): void
  stop(): void
}

/**
 * LoopScheduler — interval ticking.
 *
 * A single `setInterval(tickMs)` wakes up, lists every loop, and fires
 * `runner.tick(id)` for each non-paused loop that `isDue`. Ticks are
 * fire-and-forget and per-loop errors are swallowed so one bad loop can't
 * kill the scheduler.
 */

/** Minute bucket for cron de-dup; null lastRunAt sorts before any real minute. */
function minute(x: number | undefined): number {
  return x == null ? -Infinity : Math.floor(x / 60000)
}

/**
 * Is this loop due to fire at time `t`?
 *
 * Discriminated on `spec.trigger.kind` so tsc enforces exhaustiveness — a new
 * trigger kind without a case here is a compile error.
 *
 * - cron: fires when `t` lands in a matching minute, at most once per minute
 *   (tracked via `lastRunAt`'s minute bucket). NOTE: relies on tickMs <= 60000
 *   so the sweep can't skip over a whole matching minute and miss it.
 * - interval: fires once `everyMs` has elapsed since the last run.
 */
function isDue(spec: LoopSpec, state: LoopState, t: number): boolean {
  const tr = spec.trigger
  switch (tr.kind) {
    case 'cron':
      return cronMatches(tr.expr, new Date(t)) && minute(state.lastRunAt) < minute(t)
    case 'interval':
    default:
      return t - (state.lastRunAt ?? 0) >= tr.everyMs
  }
}
export function loopScheduler(deps: LoopSchedulerDeps): LoopScheduler {
  const now = deps.now ?? Date.now
  let timer: ReturnType<typeof setInterval> | undefined

  const sweep = async (): Promise<void> => {
    let loops
    try {
      loops = await deps.store.list()
    } catch {
      return // a listing failure shouldn't kill the scheduler
    }
    const t = now()
    for (const { spec, state } of loops) {
      if (state.paused) continue
      if (!isDue(spec, state, t)) continue
      // fire-and-forget; swallow per-loop errors so one bad loop doesn't kill the rest
      void Promise.resolve()
        .then(() => deps.runner.tick(spec.id, { kind: 'schedule' }))
        .catch(() => {})
    }
  }

  return {
    start() {
      if (timer) return // idempotent
      timer = setInterval(() => { void sweep() }, deps.tickMs)
    },
    stop() {
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }
    },
  }
}
