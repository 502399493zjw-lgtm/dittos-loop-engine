import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { TraceEvent, TraceStore } from './types'

/**
 * jsonTraceStore — JSON-backed, in-process trace persistence.
 *
 * Mirrors jsonSessionStore/jsonLoopStore: mkdir -p the dir, persist the whole
 * collection to trace.json, read-modify-write on each append. seq is monotonic
 * per turn (continues from the persisted max for that turn); created_at via the
 * injectable clock so tests stay deterministic.
 */
export function jsonTraceStore(dir: string, opts?: { now?: () => number }): TraceStore {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const now = opts?.now ?? Date.now
  const file = join(dir, 'trace.json')

  const readAll = (): TraceEvent[] => {
    if (!existsSync(file)) return []
    return JSON.parse(readFileSync(file, 'utf8')) as TraceEvent[]
  }
  const writeAll = (rows: TraceEvent[]) => { writeFileSync(file, JSON.stringify(rows, null, 2) + '\n') }

  return {
    async append(turnId, input) {
      const events = readAll()
      const turnSeqs = events.filter((e) => e.turn_id === turnId).map((e) => e.seq)
      const seq = turnSeqs.length === 0 ? 0 : Math.max(...turnSeqs) + 1
      const event: TraceEvent = {
        turn_id: turnId,
        seq,
        kind: input.kind,
        severity: input.severity ?? 'info',
        ...(input.parent_event_id !== undefined ? { parent_event_id: input.parent_event_id } : {}),
        payload: input.payload,
        created_at: now(),
      }
      events.push(event)
      writeAll(events)
      return event
    },
    async list(turnId, afterSeq) {
      return readAll()
        .filter((e) => e.turn_id === turnId && (afterSeq === undefined || e.seq > afterSeq))
        .sort((a, b) => a.seq - b.seq)
    },
  }
}
