/**
 * daemonHub — tracks the (single) connected daemon conn and correlates turns
 * by turnId (spec §3). The engine's daemonExecutor calls `dispatch` to send an
 * `agent:run`; the server routes inbound daemon messages (turn:start /
 * trace:batch / turn:end) back in via `handleMessage`. One daemon per engine
 * (slim) — registering a second conn replaces the first.
 */
import type { MappedEvent } from '../chat/streamExecutor'
import type {
  AgentRunMessage,
  DaemonToEngineMessage,
} from './protocol'

/**
 * Transport-agnostic handle to the connected daemon. The server adapts a WS to
 * this shape; tests pass a fake that scripts the daemon's replies. `send` must
 * serialize the engine→daemon message onto the wire.
 */
export interface DaemonConn {
  send(msg: import('./protocol').EngineToDaemonMessage): void
}

/** The fields a caller supplies for one dispatched run (turnId is passed separately). */
export interface DispatchRequest {
  channelId?: string
  prompt: string
  model?: string
}

/** Resolved when the daemon emits turn:end for the dispatched turn. */
export interface DispatchResult {
  finalText: string
  usage?: unknown
  isError?: boolean
  errorText?: string
}

export interface DaemonHub {
  /** Register the connected daemon conn. Replaces any prior conn (single daemon). */
  register(conn: DaemonConn): void
  /** Drop the conn if it is the current one (no-op for a stale conn). */
  unregister(conn: DaemonConn): void
  /** True when a daemon is currently connected. */
  hasDaemon(): boolean
  /**
   * Dispatch one turn: send agent:run, forward each trace:batch event to
   * onEvent, resolve on turn:end. Rejects if no daemon is connected.
   */
  dispatch(turnId: string, req: DispatchRequest, onEvent: (e: MappedEvent) => void): Promise<DispatchResult>
  /** Route an inbound daemon→engine message into the hub (server wires this). */
  handleMessage(msg: DaemonToEngineMessage): void
}

/** Internal per-turn correlation state. */
interface Pending {
  onEvent: (e: MappedEvent) => void
  resolve: (r: DispatchResult) => void
  reject: (err: Error) => void
}

export function daemonHub(): DaemonHub {
  let conn: DaemonConn | undefined
  const pending = new Map<string, Pending>()

  const failAll = (err: Error) => {
    for (const [, p] of pending) p.reject(err)
    pending.clear()
  }

  return {
    register(c: DaemonConn): void {
      conn = c
    },
    unregister(c: DaemonConn): void {
      // Only drop if it is the current conn; a stale conn closing is a no-op.
      if (conn === c) {
        conn = undefined
        // In-flight turns can never complete without a daemon — fail them.
        failAll(new Error('daemon disconnected'))
      }
    },
    hasDaemon(): boolean {
      return conn !== undefined
    },
    dispatch(turnId: string, req: DispatchRequest, onEvent: (e: MappedEvent) => void): Promise<DispatchResult> {
      const current = conn
      if (!current) {
        return Promise.reject(new Error('no daemon connected'))
      }
      return new Promise<DispatchResult>((resolve, reject) => {
        pending.set(turnId, { onEvent, resolve, reject })
        const run: AgentRunMessage = {
          type: 'agent:run',
          turnId,
          prompt: req.prompt,
          ...(req.channelId !== undefined ? { channelId: req.channelId } : {}),
          ...(req.model !== undefined ? { model: req.model } : {}),
        }
        try {
          current.send(run)
        } catch (err) {
          pending.delete(turnId)
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
    },
    handleMessage(msg: DaemonToEngineMessage): void {
      switch (msg.type) {
        case 'daemon:hello':
          // No turn correlation; presence is tracked by register().
          return
        case 'turn:start':
          // Acknowledged; no per-event work until trace:batch arrives.
          return
        case 'trace:batch': {
          const p = pending.get(msg.turnId)
          if (!p) return
          for (const e of msg.events) p.onEvent(e)
          return
        }
        case 'turn:end': {
          const p = pending.get(msg.turnId)
          if (!p) return
          pending.delete(msg.turnId)
          const isError = msg.status === 'failed'
          p.resolve({
            finalText: msg.finalText,
            ...(msg.usage !== undefined ? { usage: msg.usage } : {}),
            ...(isError ? { isError: true } : {}),
            ...(isError && msg.error !== undefined ? { errorText: msg.error } : {}),
          })
          return
        }
      }
    },
  }
}
