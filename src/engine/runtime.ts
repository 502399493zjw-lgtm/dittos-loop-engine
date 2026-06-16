import type { EngineEvent, FlowApi, Flow, RunDeps, RunStatus, AgentOpts } from '../types'
import { makeIdGen, wallClock } from './ids'

export async function runFlow(flow: Flow, deps: RunDeps): Promise<{ status: RunStatus; result?: unknown }> {
  const now = deps.now ?? wallClock
  const nextId = deps.nextId ?? makeIdGen()
  const { runId, executor, defaultAgent, emit } = deps
  let activePhase: string | null = null

  emit({ type: 'run_started', runId, args: deps.args, ts: now() })

  // Exposed so parallel()/pipeline() (Tasks 5/6) reuse the same agent path.
  async function runAgent(prompt: string, opts: AgentOpts = {}): Promise<string | Record<string, unknown>> {
    const phaseId = opts.phase ?? activePhase
    const nodeId = nextId('agent')
    const agentId = opts.agent ?? defaultAgent
    const label = opts.label ?? prompt.slice(0, 40)
    emit({ type: 'agent_started', runId, nodeId, phaseId, agentId, label, prompt, ts: now() })
    const start = now()
    try {
      const res = await executor.run({ agentId, prompt, model: opts.model, schema: opts.schema })
      emit({ type: 'agent_done', runId, nodeId, status: 'ok', result: res.text, cost: res.cost, durationMs: now() - start, ts: now() })
      if (opts.schema) { try { return JSON.parse(res.text) as Record<string, unknown> } catch { return res.text } }
      return res.text
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      emit({ type: 'agent_done', runId, nodeId, status: 'failed', error: msg, durationMs: now() - start, ts: now() })
      throw err
    }
  }

  const api: FlowApi & { __runAgent: typeof runAgent } = {
    __runAgent: runAgent,
    agent: runAgent,
    phase(title: string) {
      if (activePhase) emit({ type: 'phase_done', runId, phaseId: activePhase, status: 'ok', ts: now() })
      activePhase = nextId('phase')
      emit({ type: 'phase_started', runId, phaseId: activePhase, title, ts: now() })
    },
    log(message: string) { emit({ type: 'log', runId, message, ts: now() }) },
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
    return { status: 'completed', result }
  } catch (err) {
    emit({ type: 'run_done', runId, status: 'failed', ts: now() })
    return { status: 'failed' }
  }
}

// Imported here; defined in Tasks 5/6. Re-exported for the runtime to call.
import { bindParallel } from './parallel'
import { bindPipeline } from './pipeline'
