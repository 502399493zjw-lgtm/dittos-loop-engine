/**
 * daemonHub — tracks the connected daemon conns KEYED BY userId and correlates
 * turns by turnId (spec §1). Each user links their OWN local daemon; the engine's
 * daemonExecutor calls `dispatch(userId, ...)` to send an `agent:run` to that
 * user's conn, and the server routes inbound daemon messages (turn:start /
 * trace:batch / turn:end) back in via `handleMessage`. Registering a second conn
 * for the same user replaces the first; distinct users are independent.
 */
import type { MappedEvent } from '../chat/streamExecutor'
import type {
  AgentRunMessage,
  DaemonToEngineMessage,
} from './protocol'

/**
 * Transport-agnostic handle to a connected daemon. The server adapts a WS to
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
  /** Register `userId`'s daemon conn. Replaces any prior conn for that user. */
  register(userId: string, conn: DaemonConn): void
  /**
   * Drop `userId`'s conn and fail any of that user's in-flight turns. Pass the
   * `conn` to make a stale socket's close a no-op: if the user has since
   * reconnected (a newer conn is registered), unregistering the old one must not
   * drop the replacement. Omit `conn` to force-drop whatever is registered.
   */
  unregister(userId: string, conn?: DaemonConn): void
  /** True when `userId` currently has a daemon connected. */
  hasDaemon(userId: string): boolean
  /**
   * Dispatch one turn to `userId`'s daemon: send agent:run, forward each
   * trace:batch event to onEvent, resolve on turn:end. Rejects if that user has
   * no daemon connected.
   */
  dispatch(userId: string, turnId: string, req: DispatchRequest, onEvent: (e: MappedEvent) => void): Promise<DispatchResult>
  /** Route an inbound daemon→engine message into the hub (server wires this). */
  handleMessage(msg: DaemonToEngineMessage): void
}

/** Internal per-turn correlation state. `userId` lets unregister fail only that user's turns. */
interface Pending {
  userId: string
  onEvent: (e: MappedEvent) => void
  resolve: (r: DispatchResult) => void
  reject: (err: Error) => void
}

export function daemonHub(): DaemonHub {
  // userId -> that user's connected daemon conn.
  const conns = new Map<string, DaemonConn>()
  // turnId -> the in-flight dispatch awaiting the daemon's reply.
  const pending = new Map<string, Pending>()

  // Fail (and drop) every in-flight turn belonging to `userId`.
  const failUser = (userId: string, err: Error) => {
    for (const [turnId, p] of pending) {
      if (p.userId === userId) {
        pending.delete(turnId)
        p.reject(err)
      }
    }
  }

  return {
    register(userId: string, conn: DaemonConn): void {
      conns.set(userId, conn)
    },
    unregister(userId: string, conn?: DaemonConn): void {
      const current = conns.get(userId)
      if (current === undefined) return
      // A stale socket closing after the user reconnected must not drop the
      // replacement: only unregister when no conn is given OR it is the current one.
      if (conn !== undefined && conn !== current) return
      conns.delete(userId)
      // In-flight turns for this user can never complete without their daemon — fail them.
      failUser(userId, new Error('daemon disconnected'))
    },
    hasDaemon(userId: string): boolean {
      return conns.has(userId)
    },
    dispatch(userId: string, turnId: string, req: DispatchRequest, onEvent: (e: MappedEvent) => void): Promise<DispatchResult> {
      const conn = conns.get(userId)
      if (!conn) {
        return Promise.reject(new Error('no daemon connected'))
      }
      return new Promise<DispatchResult>((resolve, reject) => {
        pending.set(turnId, { userId, onEvent, resolve, reject })
        const run: AgentRunMessage = {
          type: 'agent:run',
          turnId,
          prompt: req.prompt,
          ...(req.channelId !== undefined ? { channelId: req.channelId } : {}),
          ...(req.model !== undefined ? { model: req.model } : {}),
        }
        try {
          conn.send(run)
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
