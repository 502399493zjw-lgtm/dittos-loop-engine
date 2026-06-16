import type { EngineEvent, FlowApi, Flow, RunDeps, RunStatus, AgentOpts, Memory, ApprovalResult } from '../types'
import { makeIdGen, wallClock } from './ids'

/** In-process memory used when a run has no injected (file-backed) memory. */
function noopMemory(): Memory {
  const lines: string[] = []
  return { read: () => lines.join('\n'), append: (l: string) => { lines.push(l) } }
}

/** Thrown when cumulative run cost reaches the per-run budget cap; turned into a `failed` run by runFlow's catch. */
export class BudgetExceeded extends Error {
  constructor(public readonly spent: number) {
    super(`budget exceeded: spent ${spent}`)
    this.name = 'BudgetExceeded'
  }
}

export async function runFlow(flow: Flow, deps: RunDeps): Promise<{ status: RunStatus; result?: unknown; cursor?: unknown }> {
  const now = deps.now ?? wallClock
  const nextId = deps.nextId ?? makeIdGen()
  const { runId, executor, defaultAgent, emit } = deps
  let activePhase: string | null = null
  let spent = 0
  // The committed cursor is staged here; only flushed into the return value if the run completes.
  let committed: { cursor?: unknown } = {}

  emit({ type: 'run_started', runId, args: deps.args, ts: now() })

  // Exposed so parallel()/pipeline() (Tasks 5/6) reuse the same agent path.
  async function runAgent(prompt: string, opts: AgentOpts = {}): Promise<string | Record<string, unknown>> {
    const phaseId = opts.phase ?? activePhase
    const nodeId = nextId('agent')
    const agentId = opts.agent ?? defaultAgent
    const label = opts.label ?? prompt.slice(0, 40)
    emit({ type: 'agent_started', runId, nodeId, phaseId, agentId, label, prompt, ts: now() })
    const start = now()
    let parsed: string | Record<string, unknown>
    let cost = 0
    try {
      const res = await executor.run({ agentId, prompt, model: opts.model, schema: opts.schema })
      emit({ type: 'agent_done', runId, nodeId, status: 'ok', result: res.text, cost: res.cost, durationMs: now() - start, ts: now() })
      cost = res.cost ?? 0
      if (opts.schema) { try { parsed = JSON.parse(res.text) as Record<string, unknown> } catch { parsed = res.text } }
      else parsed = res.text
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emit({ type: 'agent_done', runId, nodeId, status: 'failed', error: msg, durationMs: now() - start, ts: now() })
      throw err
    }
    // Budget accounting happens AFTER the agent succeeds — exceeding the cap fails the run, not the node.
    spent += cost
    if (deps.budgetUsd != null && spent >= deps.budgetUsd) {
      emit({ type: 'budget_exceeded', runId, spent, cap: deps.budgetUsd, ts: now() })
      throw new BudgetExceeded(spent)
    }
    return parsed
  }

  // Human-in-the-loop gate: emit a request, await the injected resolver (or auto-approve so flows never hang), emit the resolution.
  async function approval(prompt: string, opts: { options?: string[] } = {}): Promise<ApprovalResult> {
    const approvalId = nextId('apr')
    const nodeId = nextId('node')
    emit({ type: 'approval_requested', runId, approvalId, nodeId, prompt, options: opts.options, ts: now() })
    const result = deps.awaitApproval
      ? await deps.awaitApproval({ runId, approvalId, prompt, options: opts.options })
      : { decision: opts.options?.[0] ?? 'approve' }
    emit({ type: 'approval_resolved', runId, approvalId, decision: result.decision, note: result.note, ts: now() })
    return result
  }

  const api: FlowApi & { __runAgent: typeof runAgent } = {
    __runAgent: runAgent,
    agent: runAgent,
    approval,
    phase(title: string) {
      if (activePhase) emit({ type: 'phase_done', runId, phaseId: activePhase, status: 'ok', ts: now() })
      activePhase = nextId('phase')
      emit({ type: 'phase_started', runId, phaseId: activePhase, title, ts: now() })
    },
    log(message: string) { emit({ type: 'log', runId, message, ts: now() }) },
    commit(patch: { cursor?: unknown }) { committed = { ...committed, ...patch } },
    memory: deps.memory ?? noopMemory(),
    // parallel/pipeline are attached by Tasks 5/6 (bindParallel/bindPipeline) to avoid a circular import.
    parallel: async () => { throw new Error('parallel not bound') },
    pipeline: async () => { throw new Error('pipeline not bound') },
    args: deps.args,
  }
  // Late-bind concurrency primitives (Tasks 5/6 export binders that close over runAgent + this api).
  bindParallel(api)
  bindPipeline(api)

  try {
    const result = await flow(api)
    const summary = typeof result === 'string' ? result : undefined
    emit({ type: 'run_done', runId, status: 'completed', summary, result, ts: now() })
    // Only surface the cursor if the flow actually committed one (keeps the no-commit return shape unchanged).
    return { status: 'completed', result, ...('cursor' in committed ? { cursor: committed.cursor } : {}) }
  } catch (err) {
    emit({ type: 'run_done', runId, status: 'failed', ts: now() })
    return { status: 'failed' }
  }
}

// Imported here; defined in Tasks 5/6. Re-exported for the runtime to call.
import { bindParallel } from './parallel'
import { bindPipeline } from './pipeline'
