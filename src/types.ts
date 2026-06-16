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

export interface ApprovalRequest {
  runId: string
  approvalId: string
  prompt: string
  options?: string[]
}
export interface ApprovalResult {
  decision: string
  note?: string
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
  | { type: 'budget_exceeded'; runId: string; spent: number; cap: number; ts: number }
  | { type: 'approval_requested'; runId: string; approvalId: string; nodeId: string; prompt: string; options?: string[]; ts: number }
  | { type: 'approval_resolved'; runId: string; approvalId: string; decision: string; note?: string; ts: number }
  | { type: 'run_done'; runId: string; status: RunStatus; summary?: string; result?: unknown; ts: number }

/** A per-loop ratcheting memory surface (read full text / append a line). */
export interface Memory {
  read(): string
  append(line: string): void
}

export interface FlowApi {
  agent(prompt: string, opts?: AgentOpts): Promise<string | Record<string, unknown>>
  /** Human-in-the-loop gate; auto-approves to options[0] (or 'approve') when no awaiter is wired. */
  approval(prompt: string, opts?: { options?: string[] }): Promise<ApprovalResult>
  parallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>>
  pipeline(items: unknown[], ...stages: Array<(prev: unknown, item: unknown, i: number) => Promise<unknown>>): Promise<unknown[]>
  phase(title: string): void
  log(message: string): void
  /** Record the new cursor; only persisted if the run completes. */
  commit(patch: { cursor?: unknown }): void
  /** Per-loop memory.md surface; falls back to an in-process noop when no memory is injected. */
  memory: Memory
  args: unknown
}
export type Flow = (api: FlowApi) => Promise<unknown>

export interface RunDeps {
  runId: string
  executor: Executor
  defaultAgent: string
  args?: unknown
  /** per-run cost cap in USD; undefined = no cap */
  budgetUsd?: number
  /** per-loop memory surface; when absent the run gets an in-process noop */
  memory?: Memory
  emit: (e: EngineEvent) => void
  /** resolves an approval gate; when absent api.approval auto-approves so flows never hang */
  awaitApproval?: (req: ApprovalRequest) => Promise<ApprovalResult>
  /** injectable for deterministic tests */
  now?: () => number
  nextId?: (prefix: string) => string
}
