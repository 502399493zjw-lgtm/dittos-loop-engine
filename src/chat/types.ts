/**
 * Chat data-layer types for the standalone-chat wire contract (§1).
 * Turn = one agent reply; TraceEvent = one step inside a turn's activity trace.
 * Both stores are JSON-backed and scoped by ownerId like loops/sessions.
 */

export type TurnStatus = 'queued' | 'in_progress' | 'completed' | 'failed'

/** Opaque usage block surfaced from the agent run (cost/tokens). */
export type TurnUsage = Record<string, unknown>

/** One agent reply to a channel message. */
export interface Turn {
  turn_id: string
  agent_id: string
  channel_id: string
  trigger_msg_id: string
  trigger_preview?: string
  status: TurnStatus
  started_at?: number
  last_event_at?: number
  completed_at?: number
  error_code?: string
  error_message?: string
  usage?: TurnUsage
  created_at: number
  /** Owner scope (auth); mirrors loops/sessions. Unowned = visible to all (dev). */
  ownerId?: string
}

/** Fields accepted when creating a Turn; the store fills turn_id / status / created_at. */
export interface CreateTurnInput {
  agent_id: string
  channel_id: string
  trigger_msg_id: string
  trigger_preview?: string
  /** Defaults to 'queued'. */
  status?: TurnStatus
  ownerId?: string
}

/** Patch applied by setStatus; merged over the stored Turn. */
export interface TurnPatch {
  status?: TurnStatus
  started_at?: number
  last_event_at?: number
  completed_at?: number
  error_code?: string
  error_message?: string
  usage?: TurnUsage
}

export interface TurnStore {
  create(turn: CreateTurnInput): Promise<Turn>
  get(id: string): Promise<Turn | undefined>
  /** Turns for one channel in creation order; narrow to one owner when opts.ownerId is set. */
  listByChannel(channelId: string, opts?: { ownerId?: string }): Promise<Turn[]>
  setStatus(id: string, patch: TurnPatch): Promise<Turn>
}

export type TraceKind =
  | 'thinking'
  | 'tool_use_start'
  | 'tool_use_result'
  | 'text_delta'
  | 'text'
  | 'system'
  | 'error'
  | 'result'

export type TraceSeverity = 'info' | 'warn' | 'error' | 'fatal'

/** One step in a turn's activity trace. seq strictly increases per turn. */
export interface TraceEvent {
  turn_id: string
  seq: number
  kind: TraceKind
  severity: TraceSeverity
  parent_event_id?: string
  payload: Record<string, unknown>
  created_at: number
}

/** Fields accepted when appending a trace event; the store fills turn_id / seq / created_at and defaults severity. */
export interface AppendTraceInput {
  kind: TraceKind
  /** Defaults to 'info'. */
  severity?: TraceSeverity
  parent_event_id?: string
  payload: Record<string, unknown>
}

export interface TraceStore {
  /** Appends an event, assigning the next monotonic seq for the turn. */
  append(turnId: string, event: AppendTraceInput): Promise<TraceEvent>
  /** Events for one turn in seq order; when afterSeq is given, only events with seq > afterSeq. */
  list(turnId: string, afterSeq?: number): Promise<TraceEvent[]>
}
