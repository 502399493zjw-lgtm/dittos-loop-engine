/**
 * One node of a loop's structured execution body. Maps 1:1 onto the engine's
 * `agent` / `parallel` / `phase` primitives so the tick agent can reliably adapt
 * it (no arbitrary code in v1). `children` nests steps under a `phase`/`parallel`.
 */
export interface Step {
  id: string
  kind: 'agent' | 'parallel' | 'phase'
  label: string
  /** The sub-agent task prompt (for `agent` steps). */
  prompt?: string
  /** Nested steps for `phase` (sequence) / `parallel` (fan-out) containers. */
  children?: Step[]
}

/** The structured execution body of a loop tick — the "workflow" the agent runs/adapts. */
export interface ExecutionBody {
  steps: Step[]
}

/**
 * Unified, scriptable trigger covering the 6 re-entry patterns. Carries a short
 * human description the UI shows (cron rendered 中文, truncated with "…").
 */
export interface TriggerSpec {
  kind: 'self-paced' | 'interval' | 'cron' | 'event' | 'condition' | 'manual'
  /** For `interval`: fire every N ms. */
  everyMs?: number
  /** For `cron`: the cron expression (rendered human-readable in the UI). */
  expr?: string
  /** For `event`/`condition`: the watched event or boolean condition. */
  condition?: string
  /** Short human-readable description shown in the UI. */
  description: string
}

/**
 * The loop *contract* (canonical artifact). Backward compatible with the earlier
 * thin spec: all new contract fields are optional and `trigger` stays optional so
 * an old minimal spec (id + flow + trigger) still typechecks and loads.
 */
export interface LoopSpec {
  id: string
  flow: string                 // key into the server's flows registry
  /** Human-readable display name (the chat-created title). Falls back to id. */
  name?: string
  /** Per-round task for the generic `agentLoop` flow (conversational creation). Legacy. */
  instructions?: string
  /** Optional — a one-shot Loop needs no trigger; stop/escalation are what's mandatory. */
  trigger?:
    | { kind: 'interval'; everyMs: number }
    | { kind: 'cron'; expr: string }
    | TriggerSpec
  budgetUsd?: number           // per-run cost cap; undefined = no cap
  maxConsecutiveFailures?: number  // default 3
  /** Which project the loop belongs to; its runs' sessions open under it. */
  projectId?: string
  /** The user who owns this loop; set by the HTTP surface when auth is configured. Unowned = visible to all (dev). */
  ownerId?: string

  // --- Contract fields (optional; absent on legacy minimal specs) ---
  /** Loop mode: one-shot run, kept-alive live loop, or project-scoped loop. */
  mode?: 'one-shot' | 'live' | 'project'
  /** What the loop is responsible for, in plain language. */
  goal?: string
  /** Boundaries of what the loop may touch. */
  scope?: string
  /** Escalation boundaries — ask before crossing these (money/prod/irreversible/…). */
  escalation?: string[]
  /** Reporting policy (what/when/to whom the loop reports). */
  reporting?: string
  /** Stop/cancel rule (mandatory at runtime; typed optional for back-compat). */
  stop?: string
  /** Structured execution body the agent runs and adapts per tick. */
  body?: ExecutionBody
}
export interface LoopState {
  cursor: unknown              // opaque; advanced by the flow via api.commit({cursor})
  consecutiveFailures: number
  paused: boolean
  pausedReason?: 'failures' | 'budget'
  lastRunAt?: number
}
export interface LoopStore {
  upsert(spec: LoopSpec): Promise<void>
  get(id: string): Promise<{ spec: LoopSpec; state: LoopState } | undefined>
  /** When ownerId is given, returns only that owner's loops; otherwise all of them. */
  list(ownerId?: string): Promise<Array<{ spec: LoopSpec; state: LoopState }>>
  setState(id: string, patch: Partial<LoopState>): Promise<void>
}
export type Notify = (loopId: string, event: { kind: 'paused'; reason: 'failures' | 'budget'; detail: string }) => void
