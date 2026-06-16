import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Turn, TurnStore } from './types'

/**
 * jsonTurnStore — JSON-backed, in-process turn persistence.
 *
 * Mirrors jsonSessionStore/jsonLoopStore: mkdir -p the dir, persist the whole
 * collection to turns.json, read-modify-write on each mutation. ids via
 * randomUUID; created_at via the injectable clock so tests stay deterministic.
 * Scoped by ownerId like loops/sessions.
 */
export function jsonTurnStore(dir: string, opts?: { now?: () => number }): TurnStore {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const now = opts?.now ?? Date.now
  const file = join(dir, 'turns.json')

  const readAll = (): Turn[] => {
    if (!existsSync(file)) return []
    return JSON.parse(readFileSync(file, 'utf8')) as Turn[]
  }
  const writeAll = (rows: Turn[]) => { writeFileSync(file, JSON.stringify(rows, null, 2) + '\n') }

  return {
    async create(input) {
      const turn: Turn = {
        turn_id: randomUUID(),
        agent_id: input.agent_id,
        channel_id: input.channel_id,
        trigger_msg_id: input.trigger_msg_id,
        ...(input.trigger_preview !== undefined ? { trigger_preview: input.trigger_preview } : {}),
        status: input.status ?? 'queued',
        ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
        created_at: now(),
      }
      const turns = readAll()
      turns.push(turn)
      writeAll(turns)
      return turn
    },
    async get(id) {
      return readAll().find((t) => t.turn_id === id)
    },
    async listByChannel(channelId, opts) {
      // Persisted in create order.
      return readAll().filter((t) =>
        t.channel_id === channelId &&
        (opts?.ownerId === undefined || t.ownerId === opts.ownerId),
      )
    },
    async setStatus(id, patch) {
      const turns = readAll()
      const idx = turns.findIndex((t) => t.turn_id === id)
      if (idx === -1) throw new Error(`turn not found: ${id}`)
      const updated: Turn = { ...turns[idx]!, ...patch }
      turns[idx] = updated
      writeAll(turns)
      return updated
    },
  }
}
