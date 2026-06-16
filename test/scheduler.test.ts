import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { loopScheduler } from '../src/loop/scheduler'
import { jsonLoopStore } from '../src/loop/jsonLoopStore'
import type { LoopRunner } from '../src/loop/loopRunner'
import type { LoopSpec, LoopStore } from '../src/loop/types'
import type { TriggerCause } from '../src/loop/triggerReason'

const spec = (over: Partial<LoopSpec> = {}): LoopSpec => ({
  id: 'L1', flow: 'demo', trigger: { kind: 'interval', everyMs: 1000 }, ...over,
})

function fakeRunner(): LoopRunner & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async tick(loopId: string) { calls.push(loopId) },
  }
}

function freshStore(): LoopStore {
  const dir = mkdtempSync(join(tmpdir(), 'sched-'))
  return jsonLoopStore(dir)
}

describe('loopScheduler — interval ticking', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('ticks a due, non-paused loop at least twice over 2 intervals', async () => {
    const store = freshStore()
    await store.upsert(spec())
    const runner = fakeRunner()
    // clock advances in lockstep with the fake timers we drive
    let clock = 0
    const sched = loopScheduler({ store, runner, tickMs: 100, now: () => clock })

    sched.start()
    // advance 2000ms in 100ms slices, moving the injected clock alongside
    for (let t = 100; t <= 2000; t += 100) {
      clock = t
      await vi.advanceTimersByTimeAsync(100)
    }
    sched.stop()

    const l1 = runner.calls.filter((id) => id === 'L1')
    expect(l1.length).toBeGreaterThanOrEqual(2)
  })

  it('does not tick a loop before its interval has elapsed', async () => {
    const store = freshStore()
    await store.upsert(spec({ trigger: { kind: 'interval', everyMs: 5000 } }))
    const runner = fakeRunner()
    let clock = 0
    const sched = loopScheduler({ store, runner, tickMs: 100, now: () => clock })

    sched.start()
    // only 1000ms elapses — below the 5000ms interval
    for (let t = 100; t <= 1000; t += 100) {
      clock = t
      await vi.advanceTimersByTimeAsync(100)
    }
    sched.stop()

    expect(runner.calls).toHaveLength(0)
  })

  it('skips a paused loop', async () => {
    const store = freshStore()
    await store.upsert(spec())
    await store.setState('L1', { paused: true, pausedReason: 'failures' })
    const runner = fakeRunner()
    let clock = 0
    const sched = loopScheduler({ store, runner, tickMs: 100, now: () => clock })

    sched.start()
    for (let t = 100; t <= 2000; t += 100) {
      clock = t
      await vi.advanceTimersByTimeAsync(100)
    }
    sched.stop()

    expect(runner.calls).toHaveLength(0)
  })

  it('stop() clears the interval (no further ticks)', async () => {
    const store = freshStore()
    await store.upsert(spec())
    const runner = fakeRunner()
    let clock = 0
    const sched = loopScheduler({ store, runner, tickMs: 100, now: () => clock })

    sched.start()
    clock = 1000
    await vi.advanceTimersByTimeAsync(1000)
    const after1s = runner.calls.length
    expect(after1s).toBeGreaterThanOrEqual(1)

    sched.stop()
    // advance well past more intervals — no new ticks should be scheduled
    clock = 10000
    await vi.advanceTimersByTimeAsync(9000)
    expect(runner.calls.length).toBe(after1s)
  })

  it('fires a cron loop in its matching minute, once, and not in a non-matching minute', async () => {
    const store = freshStore()
    // 09:00 every day; lastRunAt starts null
    await store.upsert(spec({ id: 'CRON', trigger: { kind: 'cron', expr: '0 9 * * *' } }))
    // runner-spy that, like the real loopRunner, stamps lastRunAt on each tick —
    // this is what the once-per-minute de-dup hangs off of
    const calls: string[] = []
    // clock pinned to 09:00 local time
    const nineAm = new Date(2026, 5, 16, 9, 0, 0, 0).getTime()
    let clock = nineAm
    const runner: LoopRunner = {
      async tick(loopId: string) {
        calls.push(loopId)
        await store.setState(loopId, { lastRunAt: clock })
      },
    }
    const sched = loopScheduler({ store, runner, tickMs: 100, now: () => clock })

    sched.start()
    // sweep within the 09:00 minute → fires once
    await vi.advanceTimersByTimeAsync(100)
    // advance the wall clock but stay inside 09:00 → no second fire
    clock = nineAm + 30000
    await vi.advanceTimersByTimeAsync(100)
    sched.stop()

    expect(calls.filter((id) => id === 'CRON')).toHaveLength(1)
  })

  it('does not fire a cron loop in a non-matching minute', async () => {
    const store = freshStore()
    await store.upsert(spec({ id: 'CRON', trigger: { kind: 'cron', expr: '0 9 * * *' } }))
    const runner = fakeRunner()
    // clock pinned to 10:00 — 09:00 cron must not fire
    let clock = new Date(2026, 5, 16, 10, 0, 0, 0).getTime()
    const sched = loopScheduler({ store, runner, tickMs: 100, now: () => clock })

    sched.start()
    await vi.advanceTimersByTimeAsync(100)
    sched.stop()

    expect(runner.calls.filter((id) => id === 'CRON')).toHaveLength(0)
  })

  it('ticks a due loop with a schedule cause', async () => {
    const store = freshStore()
    await store.upsert(spec())
    const causes: Array<TriggerCause | undefined> = []
    const runner: LoopRunner = {
      async tick(_loopId: string, cause?: TriggerCause) { causes.push(cause) },
    }
    let clock = 0
    const sched = loopScheduler({ store, runner, tickMs: 100, now: () => clock })

    sched.start()
    clock = 1000
    await vi.advanceTimersByTimeAsync(1000)
    sched.stop()

    expect(causes.length).toBeGreaterThanOrEqual(1)
    expect(causes.every((c) => c?.kind === 'schedule')).toBe(true)
  })

  it('one loop throwing does not stop the scheduler from ticking others', async () => {
    const store = freshStore()
    await store.upsert(spec({ id: 'BAD' }))
    await store.upsert(spec({ id: 'GOOD' }))
    const calls: string[] = []
    const runner: LoopRunner = {
      async tick(loopId: string) {
        calls.push(loopId)
        if (loopId === 'BAD') throw new Error('boom')
      },
    }
    let clock = 0
    const sched = loopScheduler({ store, runner, tickMs: 100, now: () => clock })

    sched.start()
    for (let t = 100; t <= 1100; t += 100) {
      clock = t
      await vi.advanceTimersByTimeAsync(100)
    }
    sched.stop()

    expect(calls).toContain('BAD')
    expect(calls).toContain('GOOD')
  })
})
