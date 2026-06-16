import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { jsonStore } from '../src/store/jsonStore'
import type { EngineEvent } from '../src/types'

describe('jsonStore', () => {
  it('appends events for a run and reads them back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lf-'))
    const s = jsonStore(dir)
    const e: EngineEvent = { type: 'run_started', runId: 'r1', args: null, ts: 1 }
    await s.append('r1', e)
    expect(await s.events('r1')).toEqual([e])
  })
})
