import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { jsonProjectStore } from '../src/project/jsonProjectStore'

// A deterministic clock + id factory so createdAt/id are predictable across assertions.
const clock = (start = 1000, step = 1000) => {
  let t = start - step
  return () => (t += step)
}
const ids = () => {
  let n = 0
  return () => `p${++n}`
}

describe('jsonProjectStore', () => {
  it('create returns a Project with id + name + createdAt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ps-'))
    const s = jsonProjectStore(dir, { now: clock(), id: ids() })
    const proj = await s.create('A', 'My Project')
    expect(proj.id).toBe('p1')
    expect(proj.name).toBe('My Project')
    expect(proj.ownerId).toBe('A')
    expect(proj.createdAt).toBe(1000)
  })

  it('create without an owner leaves ownerId unset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ps-'))
    const s = jsonProjectStore(dir, { now: clock(), id: ids() })
    const proj = await s.create(undefined, 'Unowned')
    expect(proj.ownerId).toBeUndefined()
    expect(proj.name).toBe('Unowned')
  })

  it('list filters by owner and returns all when omitted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ps-'))
    const s = jsonProjectStore(dir, { now: clock(), id: ids() })
    await s.create('A', 'a1')
    await s.create('A', 'a2')
    await s.create('B', 'b1')
    await s.create(undefined, 'shared')
    expect((await s.list('A')).map((p) => p.name)).toEqual(['a1', 'a2'])
    expect((await s.list('B')).map((p) => p.name)).toEqual(['b1'])
    expect((await s.list()).length).toBe(4)
  })

  it('rename updates the name and returns the updated Project', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ps-'))
    const s = jsonProjectStore(dir, { now: clock(), id: ids() })
    const proj = await s.create('A', 'old')
    const renamed = await s.rename(proj.id, 'new')
    expect(renamed?.id).toBe(proj.id)
    expect(renamed?.name).toBe('new')
    expect((await s.list('A')).map((p) => p.name)).toEqual(['new'])
  })

  it('rename returns undefined for an unknown id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ps-'))
    const s = jsonProjectStore(dir, { now: clock(), id: ids() })
    expect(await s.rename('nope', 'x')).toBeUndefined()
  })

  it('remove deletes a project and returns true; false for an unknown id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ps-'))
    const s = jsonProjectStore(dir, { now: clock(), id: ids() })
    const proj = await s.create('A', 'doomed')
    expect(await s.remove(proj.id)).toBe(true)
    expect((await s.list('A')).length).toBe(0)
    expect(await s.remove(proj.id)).toBe(false)
  })

  it('persistence survives a fresh jsonProjectStore on the same dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ps-'))
    const s1 = jsonProjectStore(dir, { now: clock(), id: ids() })
    const proj = await s1.create('A', 'kept')

    const s2 = jsonProjectStore(dir, { now: clock(), id: ids() })
    const projects = await s2.list('A')
    expect(projects.map((p) => p.name)).toEqual(['kept'])
    expect(projects[0]?.id).toBe(proj.id)
  })
})
