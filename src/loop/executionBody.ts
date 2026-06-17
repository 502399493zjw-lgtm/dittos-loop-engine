import type { FlowApi } from '../types'
import type { ExecutionBody, Step } from './types'

/**
 * Walk a structured {@link ExecutionBody} and map each {@link Step} onto the
 * engine's flow primitives (`api.phase` / `api.agent` / `api.parallel`). The tick
 * agent (乙) produces/adapts this body; here we replay it deterministically — no
 * arbitrary code, just the three step kinds.
 *
 * Returns the per-step results in body order:
 *   - `phase`    → `undefined` (phase only emits a marker)
 *   - `agent`    → the agent's result (string or parsed object)
 *   - `parallel` → an array of its children's results (failed children → null)
 */
export async function runBody(body: ExecutionBody, api: FlowApi): Promise<unknown[]> {
  const results: unknown[] = []
  for (const step of body.steps) {
    results.push(await runStep(step, api))
  }
  return results
}

async function runStep(step: Step, api: FlowApi): Promise<unknown> {
  switch (step.kind) {
    case 'phase':
      api.phase(step.label)
      return undefined
    case 'agent':
      return api.agent(step.prompt ?? step.label, { label: step.label })
    case 'parallel':
      return api.parallel(
        (step.children ?? []).map((c) => () => api.agent(c.prompt ?? c.label, { label: c.label })),
      )
  }
}
