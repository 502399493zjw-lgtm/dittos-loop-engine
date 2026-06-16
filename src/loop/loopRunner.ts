import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { runFlow } from '../engine/runtime'
import { memoryFile } from './memoryFile'
import type { Executor, EngineEvent, Flow } from '../types'
import type { LoopStore, Notify } from './types'

export interface LoopRunnerDeps {
  store: LoopStore
  executor: Executor
  flows: Record<string, Flow>
  emit: (e: EngineEvent) => void
  notify: Notify
  defaultAgent: string
  /** dir holding each loop's `<loopId>.md` ratchet memory */
  memoryDir: string
  /** injectable clock for deterministic tests */
  now?: () => number
}

export interface LoopRunner {
  /** Run one iteration of a loop and apply the platform contract. */
  tick(loopId: string): Promise<void>
}

/**
 * LoopRunner.tick — the platform contract.
 * - success → advance the committed cursor + reset consecutiveFailures
 * - throw → ++consecutiveFailures (cursor unchanged); the Nth (default 3) consecutive
 *   failure pauses the loop (reason 'failures') + notifies
 * - budget blowout → pause immediately (reason 'budget') + notify
 * - a paused loop is a no-op
 */
export function loopRunner(deps: LoopRunnerDeps): LoopRunner {
  const now = deps.now ?? Date.now

  return {
    async tick(loopId: string): Promise<void> {
      const loaded = await deps.store.get(loopId)
      if (!loaded) throw new Error(`loop not found: ${loopId}`)
      const { spec, state } = loaded
      if (state.paused) return // paused loops do not run

      const flow = deps.flows[spec.flow]
      if (!flow) throw new Error(`unknown flow: ${spec.flow}`)

      const memory = memoryFile(join(deps.memoryDir, `${loopId}.md`))

      // Sniff this run's events for a budget blowout so we can attribute the pause reason,
      // while still forwarding every event to the real emit sink.
      let budgetHit = false
      const emit = (e: EngineEvent) => {
        if (e.type === 'budget_exceeded') budgetHit = true
        deps.emit(e)
      }

      const res = await runFlow(flow, {
        runId: randomUUID(),
        executor: deps.executor,
        defaultAgent: deps.defaultAgent,
        args: { cursor: state.cursor },
        budgetUsd: spec.budgetUsd,
        memory,
        emit,
      })

      await deps.store.setState(loopId, { lastRunAt: now() })

      if (res.status === 'completed') {
        await deps.store.setState(loopId, {
          consecutiveFailures: 0,
          ...('cursor' in res ? { cursor: res.cursor } : {}),
        })
        return
      }

      // res.status === 'failed'
      const reason: 'failures' | 'budget' = budgetHit ? 'budget' : 'failures'
      const failures = state.consecutiveFailures + 1
      const threshold = spec.maxConsecutiveFailures ?? 3
      const shouldPause = reason === 'budget' || failures >= threshold

      if (shouldPause) {
        await deps.store.setState(loopId, { consecutiveFailures: failures, paused: true, pausedReason: reason })
        const detail = reason === 'budget'
          ? `per-run budget cap exceeded (budgetUsd=${spec.budgetUsd})`
          : `${failures} consecutive failures (threshold=${threshold})`
        deps.notify(loopId, { kind: 'paused', reason, detail })
      } else {
        await deps.store.setState(loopId, { consecutiveFailures: failures })
      }
    },
  }
}
