import type { LoopRunner } from './loopRunner'
import type { LoopStore } from './types'

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
 * `runner.tick(id)` for each non-paused loop whose interval has elapsed
 * (`now - (lastRunAt ?? 0) >= trigger.everyMs`). Ticks are fire-and-forget
 * and per-loop errors are swallowed so one bad loop can't kill the scheduler.
 */
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
      if (t - (state.lastRunAt ?? 0) < spec.trigger.everyMs) continue
      // fire-and-forget; swallow per-loop errors so one bad loop doesn't kill the rest
      void Promise.resolve()
        .then(() => deps.runner.tick(spec.id))
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
