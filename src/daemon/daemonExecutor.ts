/**
 * daemonExecutor — the remote executor used in DAEMON_MODE (spec §3). It
 * implements BOTH existing executor seams over the hub, so chat (StreamExecutor)
 * and loops/agent() (Executor) both run on the user's local daemon instead of
 * spawning `claude` on the prod box:
 *   - StreamExecutor.run(req, onEvent) → dispatch agent:run, forward each trace
 *     event to onEvent, resolve { finalText, usage, isError } on turn:end.
 *   - Executor.run(req)               → same dispatch, return { text: finalText, cost }.
 * No daemon connected → reject with a clear Error (prod has no local fallback).
 */
import { randomUUID } from 'node:crypto'
import type { StreamExecutor, StreamRequest, StreamResult, MappedEvent } from '../chat/streamExecutor'
import type { Executor, ExecutorRequest, ExecutorResult } from '../types'
import type { DaemonHub } from './daemonHub'

/**
 * One unified `run` that serves BOTH executor seams. `StreamExecutor.run` calls
 * it with (req, onEvent) and reads StreamResult fields; `Executor.run` calls it
 * with (req) and reads ExecutorResult fields. The optional `onEvent` + the
 * intersection return type make the single signature assignable to both — see
 * the `_asStream`/`_asExecutor` assignments below that pin it at compile time.
 */
export interface DaemonExecutor {
  run(
    req: StreamRequest | ExecutorRequest,
    onEvent?: (e: MappedEvent) => void,
  ): Promise<StreamResult & ExecutorResult>
}

/** Pull a usable cost out of an opaque usage block, if one is present. */
function costOf(usage: unknown): number | undefined {
  if (usage && typeof usage === 'object') {
    const c = (usage as { cost?: unknown; total_cost_usd?: unknown }).cost ??
      (usage as { total_cost_usd?: unknown }).total_cost_usd
    if (typeof c === 'number') return c
  }
  return undefined
}

export function daemonExecutor(hub: DaemonHub): DaemonExecutor {
  const ex: DaemonExecutor = {
    // ----- one run() serving both StreamExecutor (chat) + Executor (loops) -----
    async run(
      req: StreamRequest | ExecutorRequest,
      onEvent?: (e: MappedEvent) => void,
    ): Promise<StreamResult & ExecutorResult> {
      if (!hub.hasDaemon()) {
        throw new Error('no daemon connected: cannot run agent (DAEMON_MODE requires a linked local daemon)')
      }
      const turnId = randomUUID()
      const sink = onEvent ?? (() => {})
      const result = await hub.dispatch(
        turnId,
        { prompt: req.prompt, ...(req.model !== undefined ? { model: req.model } : {}) },
        sink,
      )
      // Both interfaces are served by one shape: StreamResult fields (finalText/
      // usage/isError) for chat + Executor fields (text/cost) for loops.
      return {
        finalText: result.finalText,
        text: result.finalText,
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
        ...(result.isError ? { isError: true } : {}),
        ...(result.errorText !== undefined ? { errorText: result.errorText } : {}),
        ...(costOf(result.usage) !== undefined ? { cost: costOf(result.usage) } : {}),
      }
    },
  }
  // Pin at compile time that the unified executor is usable as BOTH seams.
  const _asStream: StreamExecutor = ex
  const _asExecutor: Executor = ex
  void _asStream
  void _asExecutor
  return ex
}
