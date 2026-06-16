export type RunStatus = 'running' | 'completed' | 'failed'
export type NodeStatus = 'running' | 'ok' | 'failed'

export interface AgentOpts {
  /** Name a specific Dittos agent. Omitted → the run's default agent. */
  agent?: string
  /** JSON schema; when set, the executor result text is JSON.parsed + returned as object. */
  schema?: Record<string, unknown>
  model?: string
  /** Display label for the work-card; defaults to a slug of the prompt. */
  label?: string
  /** Force this node under a named phase instead of the active one. */
  phase?: string
}

export interface ExecutorRequest {
  agentId: string
  prompt: string
  model?: string
  schema?: Record<string, unknown>
}
export interface ExecutorResult {
  text: string
  raw?: unknown
  cost?: number
  tokensIn?: number
  tokensOut?: number
}
export interface Executor {
  run(req: ExecutorRequest): Promise<ExecutorResult>
}

export type EngineEvent =
  | { type: 'run_started'; runId: string; args: unknown; ts: number }
  | { type: 'phase_started'; runId: string; phaseId: string; title: string; ts: number }
  | { type: 'agent_started'; runId: string; nodeId: string; phaseId: string | null; agentId: string; label: string; prompt: string; ts: number }
  | { type: 'agent_done'; runId: string; nodeId: string; status: 'ok' | 'failed'; result?: string; error?: string; cost?: number; durationMs: number; ts: number }
  | { type: 'phase_done'; runId: string; phaseId: string; status: 'ok' | 'failed'; ts: number }
  | { type: 'log'; runId: string; message: string; ts: number }
  | { type: 'run_done'; runId: string; status: RunStatus; summary?: string; result?: unknown; ts: number }

export interface FlowApi {
  agent(prompt: string, opts?: AgentOpts): Promise<string | Record<string, unknown>>
  parallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>>
  pipeline(items: unknown[], ...stages: Array<(prev: unknown, item: unknown, i: number) => Promise<unknown>>): Promise<unknown[]>
  phase(title: string): void
  log(message: string): void
  args: unknown
}
export type Flow = (api: FlowApi) => Promise<unknown>

export interface RunDeps {
  runId: string
  executor: Executor
  defaultAgent: string
  args?: unknown
  emit: (e: EngineEvent) => void
  /** injectable for deterministic tests */
  now?: () => number
  nextId?: (prefix: string) => string
}
