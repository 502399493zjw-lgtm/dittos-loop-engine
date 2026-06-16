export interface LoopSpec {
  id: string
  flow: string                 // key into the server's flows registry
  trigger:
    | { kind: 'interval'; everyMs: number }
    | { kind: 'cron'; expr: string }
  budgetUsd?: number           // per-run cost cap; undefined = no cap
  maxConsecutiveFailures?: number  // default 3
  /** Which project the loop belongs to; its runs' sessions open under it. */
  projectId?: string
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
  list(): Promise<Array<{ spec: LoopSpec; state: LoopState }>>
  setState(id: string, patch: Partial<LoopState>): Promise<void>
}
export type Notify = (loopId: string, event: { kind: 'paused'; reason: 'failures' | 'budget'; detail: string }) => void
