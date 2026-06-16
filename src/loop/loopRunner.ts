import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { runFlow } from '../engine/runtime'
import { memoryFile } from './memoryFile'
import { describeTrigger } from './triggerReason'
import { kickoffMessage } from './kickoff'
import type { Executor, EngineEvent, Flow, ApprovalRequest, ApprovalResult } from '../types'
import type { LoopStore, Notify } from './types'
import type { SessionBus } from './sessionBus'
import type { TriggerCause } from './triggerReason'

export interface LoopRunnerDeps {
  store: LoopStore
  executor: Executor
  flows: Record<string, Flow>
  emit: (e: EngineEvent) => void
  notify: Notify
  defaultAgent: string
  /** dir holding each loop's `<loopId>.md` ratchet memory */
  memoryDir: string
  /** resolves an approval gate; forwarded into runFlow so loop-triggered runs honour human-in-the-loop gates */
  awaitApproval?: (req: ApprovalRequest) => Promise<ApprovalResult>
  /** when set, each run opens a fresh chat session under the loop's project and
   *  auto-mirrors its narration into it; when absent the runner behaves headlessly. */
  sessionBus?: SessionBus
  /** injectable clock for deterministic tests */
  now?: () => number
}

export interface LoopRunner {
  /** Run one iteration of a loop and apply the platform contract. */
  tick(loopId: string, cause?: TriggerCause): Promise<void>
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
    async tick(loopId: string, cause: TriggerCause = { kind: 'schedule' }): Promise<void> {
      const loaded = await deps.store.get(loopId)
      if (!loaded) throw new Error(`loop not found: ${loopId}`)
      const { spec, state } = loaded
      if (state.paused) return // paused loops do not run

      const flow = deps.flows[spec.flow]
      if (!flow) throw new Error(`unknown flow: ${spec.flow}`)

      const memory = memoryFile(join(deps.memoryDir, `${loopId}.md`))

      // When a session bus is wired, this run opens a fresh chat session under the
      // loop's project and posts the global kickoff (with this firing's reason).
      const bus = deps.sessionBus
      let sessionId: string | undefined
      if (bus) {
        ;({ sessionId } = await bus.createSession(spec.projectId, { title: spec.id, ...(spec.ownerId !== undefined ? { ownerId: spec.ownerId } : {}) }))
        await bus.postMessage(sessionId, kickoffMessage(describeTrigger(spec.trigger, cause)))
      }

      // Sniff this run's events for a budget blowout so we can attribute the pause reason,
      // while still forwarding every event to the real emit sink. When a session is open we
      // also mirror the run's narration (log lines + final summary) into it.
      let budgetHit = false
      const emit = (e: EngineEvent) => {
        if (e.type === 'budget_exceeded') budgetHit = true
        if (bus && sessionId) {
          if (e.type === 'log') void bus.postMessage(sessionId, e.message)
          else if (e.type === 'run_done') void bus.postMessage(sessionId, e.summary ?? `运行结束:${e.status}`)
        }
        deps.emit(e)
      }

      const res = await runFlow(flow, {
        runId: randomUUID(),
        executor: deps.executor,
        defaultAgent: deps.defaultAgent,
        // Owner routing (spec §1): the loop's runs go to the loop owner's linked
        // daemon. Forwarded only when the loop is owned; unowned dev loops route
        // to the in-process executor, which ignores it.
        ...(spec.ownerId !== undefined ? { ownerId: spec.ownerId } : {}),
        args: { cursor: state.cursor },
        budgetUsd: spec.budgetUsd,
        memory,
        awaitApproval: deps.awaitApproval,
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
