import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { EngineEvent } from '../types'

export interface Store {
  append(runId: string, e: EngineEvent): Promise<void>
  events(runId: string): Promise<EngineEvent[]>
}
export function jsonStore(dir: string): Store {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const file = (runId: string) => join(dir, `${runId}.ndjson`)
  return {
    async append(runId, e) { appendFileSync(file(runId), JSON.stringify(e) + '\n') },
    async events(runId) {
      const f = file(runId)
      if (!existsSync(f)) return []
      return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as EngineEvent)
    },
  }
}
