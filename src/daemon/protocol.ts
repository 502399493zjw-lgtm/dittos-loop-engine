/**
 * Daemon link protocol envelopes (spec §2). The prod engine never runs
 * `claude`; a local daemon connects over WS (`/daemon/ws?token=<t>`), the
 * engine dispatches a turn with `agent:run`, and the daemon streams
 * `turn:start` / `trace:batch` / `turn:end` back. Slim subset: single daemon,
 * single implicit agent, run/trace/end only (no wake/provision/resume/fanout).
 */
import type { MappedEvent } from '../chat/streamExecutor'

/** Current wire protocol version, carried in daemon:hello. */
export const PROTOCOL_VERSION = 1

// ----------------------- engine → daemon -----------------------

/** Run one turn / one-shot. Correlated end-to-end by turnId. */
export interface AgentRunMessage {
  type: 'agent:run'
  turnId: string
  channelId?: string
  prompt: string
  model?: string
}

/** (optional v1) Request the daemon kill an in-flight run. */
export interface AgentCancelMessage {
  type: 'agent:cancel'
  turnId: string
}

export type EngineToDaemonMessage = AgentRunMessage | AgentCancelMessage

// ----------------------- daemon → engine -----------------------

/** Sent once on connect, after auth. */
export interface DaemonHelloMessage {
  type: 'daemon:hello'
  protocol: number
}

/** The daemon began running the turn. */
export interface TurnStartMessage {
  type: 'turn:start'
  turnId: string
}

/**
 * A batch of trace events for a turn. `events` are the same kind/payload the
 * engine already produces from `claude -p stream-json` (MappedEvent) — the
 * engine forwards them to onEvent unchanged.
 */
export interface TraceBatchMessage {
  type: 'trace:batch'
  turnId: string
  events: MappedEvent[]
}

/** The daemon finished (or failed) the turn; resolves the dispatch handle. */
export interface TurnEndMessage {
  type: 'turn:end'
  turnId: string
  status: 'completed' | 'failed'
  finalText: string
  usage?: unknown
  error?: string
}

export type DaemonToEngineMessage =
  | DaemonHelloMessage
  | TurnStartMessage
  | TraceBatchMessage
  | TurnEndMessage

// ----------------------- parse helpers -----------------------

/**
 * Parse a raw WS frame (string/Buffer) into a daemon→engine message, or
 * undefined when it is blank/unparseable/not a known envelope. Pure — no I/O.
 */
export function parseDaemonMessage(raw: string | Buffer): DaemonToEngineMessage | undefined {
  const text = typeof raw === 'string' ? raw : raw.toString()
  const trimmed = text.trim()
  if (!trimmed) return undefined
  let obj: unknown
  try {
    obj = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (!obj || typeof obj !== 'object') return undefined
  const type = (obj as { type?: unknown }).type
  if (
    type === 'daemon:hello' ||
    type === 'turn:start' ||
    type === 'trace:batch' ||
    type === 'turn:end'
  ) {
    return obj as DaemonToEngineMessage
  }
  return undefined
}
