import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { LoopSpec, LoopState, LoopStore } from './types'

interface Persisted { spec: LoopSpec; state: LoopState }

const defaultState = (): LoopState => ({ cursor: null, consecutiveFailures: 0, paused: false })

export function jsonLoopStore(dir: string): LoopStore {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const file = (id: string) => join(dir, `${id}.json`)
  const read = (id: string): Persisted | undefined => {
    const f = file(id)
    if (!existsSync(f)) return undefined
    return JSON.parse(readFileSync(f, 'utf8')) as Persisted
  }
  const write = (id: string, data: Persisted) => { writeFileSync(file(id), JSON.stringify(data, null, 2) + '\n') }
  return {
    async upsert(spec) {
      const existing = read(spec.id)
      write(spec.id, { spec, state: existing?.state ?? defaultState() })
    },
    async get(id) { return read(id) },
    async list() {
      return readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Persisted)
    },
    async setState(id, patch) {
      const existing = read(id)
      if (!existing) throw new Error(`loop not found: ${id}`)
      write(id, { spec: existing.spec, state: { ...existing.state, ...patch } })
    },
  }
}
