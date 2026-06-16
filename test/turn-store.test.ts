import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { jsonTurnStore } from '../src/chat/turnStore'

const clock = (start = 1000, step = 1000) => {
  let t = start - step
  return () => (t += step)
}

describe('jsonTurnStore', () => {
  it('create returns a Turn with id, status queued, created_at + echoed fields', async () => {
    const s = jsonTurnStore(mkdtempSync(join(tmpdir(), 'ts-')), { now: clock() })
    const t = await s.create({
      agent_id: 'claude',
      channel_id: 'chan-1',
      trigger_msg_id: 'msg-1',
      trigger_preview: 'hi there',
      ownerId: 'A',
    })
    expect(t.turn_id).toBeTruthy()
    expect(t.agent_id).toBe('claude')
    expect(t.channel_id).toBe('chan-1')
    expect(t.trigger_msg_id).toBe('msg-1')
    expect(t.trigger_preview).toBe('hi there')
    expect(t.status).toBe('queued')
    expect(t.created_at).toBe(1000)
  })

  it('create accepts an explicit status', async () => {
    const s = jsonTurnStore(mkdtempSync(join(tmpdir(), 'ts-')), { now: clock() })
    const t = await s.create({ agent_id: 'claude', channel_id: 'c', trigger_msg_id: 'm', status: 'in_progress' })
    expect(t.status).toBe('in_progress')
  })

  it('get returns the stored Turn; undefined for unknown', async () => {
    const s = jsonTurnStore(mkdtempSync(join(tmpdir(), 'ts-')), { now: clock() })
    const t = await s.create({ agent_id: 'a', channel_id: 'c', trigger_msg_id: 'm' })
    expect((await s.get(t.turn_id))?.turn_id).toBe(t.turn_id)
    expect(await s.get('nope')).toBeUndefined()
  })

  it('listByChannel returns that channel\'s turns in creation order', async () => {
    const s = jsonTurnStore(mkdtempSync(join(tmpdir(), 'ts-')), { now: clock() })
    const a1 = await s.create({ agent_id: 'a', channel_id: 'A', trigger_msg_id: 'm1' })
    await s.create({ agent_id: 'a', channel_id: 'B', trigger_msg_id: 'm2' })
    const a2 = await s.create({ agent_id: 'a', channel_id: 'A', trigger_msg_id: 'm3' })
    const got = await s.listByChannel('A')
    expect(got.map((t) => t.turn_id)).toEqual([a1.turn_id, a2.turn_id])
  })

  it('listByChannel narrows by ownerId when given', async () => {
    const s = jsonTurnStore(mkdtempSync(join(tmpdir(), 'ts-')), { now: clock() })
    const a = await s.create({ agent_id: 'a', channel_id: 'C', trigger_msg_id: 'm1', ownerId: 'A' })
    await s.create({ agent_id: 'a', channel_id: 'C', trigger_msg_id: 'm2', ownerId: 'B' })
    expect((await s.listByChannel('C', { ownerId: 'A' })).map((t) => t.turn_id)).toEqual([a.turn_id])
    expect((await s.listByChannel('C')).length).toBe(2)
  })

  it('setStatus patches the Turn and merges fields', async () => {
    const s = jsonTurnStore(mkdtempSync(join(tmpdir(), 'ts-')), { now: clock() })
    const t = await s.create({ agent_id: 'a', channel_id: 'c', trigger_msg_id: 'm' })
    const inProg = await s.setStatus(t.turn_id, { status: 'in_progress', started_at: 2000 })
    expect(inProg.status).toBe('in_progress')
    expect(inProg.started_at).toBe(2000)
    const done = await s.setStatus(t.turn_id, { status: 'completed', completed_at: 3000, usage: { cost_usd: 0.01 } })
    expect(done.status).toBe('completed')
    expect(done.started_at).toBe(2000) // preserved
    expect(done.completed_at).toBe(3000)
    expect(done.usage).toEqual({ cost_usd: 0.01 })
  })

  it('setStatus can record a failure', async () => {
    const s = jsonTurnStore(mkdtempSync(join(tmpdir(), 'ts-')), { now: clock() })
    const t = await s.create({ agent_id: 'a', channel_id: 'c', trigger_msg_id: 'm' })
    const failed = await s.setStatus(t.turn_id, { status: 'failed', error_code: 'spawn', error_message: 'boom' })
    expect(failed.status).toBe('failed')
    expect(failed.error_code).toBe('spawn')
    expect(failed.error_message).toBe('boom')
  })

  it('setStatus throws for an unknown turn', async () => {
    const s = jsonTurnStore(mkdtempSync(join(tmpdir(), 'ts-')), { now: clock() })
    await expect(s.setStatus('nope', { status: 'completed' })).rejects.toThrow()
  })

  it('persists across a fresh store on the same dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-'))
    const s1 = jsonTurnStore(dir, { now: clock() })
    const t = await s1.create({ agent_id: 'a', channel_id: 'c', trigger_msg_id: 'm' })
    const s2 = jsonTurnStore(dir, { now: clock() })
    expect((await s2.get(t.turn_id))?.turn_id).toBe(t.turn_id)
  })
})
