import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { createServer } from '../src/server'
import { fakeExecutor } from '../src/executor/fake'
import { fakeGithubOAuth } from '../src/auth/github'
import { signState } from '../src/auth/state'
import { jsonUserStore } from '../src/auth/jsonUserStore'
import { jsonTokenStore } from '../src/auth/jsonTokenStore'
import { jsonProjectStore } from '../src/project/jsonProjectStore'
import type { Project } from '../src/project/types'

const sessionSecret = 'test-session-secret'
const appBaseUrl = 'http://localhost:5173'
const hashOf = (loc: string) => new URL(loc).hash

function projectServer(withStore = true) {
  const projectStore = withStore
    ? jsonProjectStore(mkdtempSync(join(tmpdir(), 'srv-proj-')))
    : undefined
  const srv = createServer({
    executor: fakeExecutor(), defaultAgent: 'claude', flows: {}, storeDir: undefined, projectStore,
  })
  return { srv, projectStore }
}

describe('server — project endpoints', () => {
  it('POST /projects creates a Project, GET /projects lists it', async () => {
    const { srv } = projectServer()
    const { port } = await srv.listen(0)

    const create = await fetch(`http://localhost:${port}/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Alpha' }),
    })
    expect(create.status).toBe(200)
    const project = (await create.json()) as Project
    expect(project.id).toBeTruthy()
    expect(project.name).toBe('Alpha')
    expect(typeof project.createdAt).toBe('number')

    const list = (await (await fetch(`http://localhost:${port}/projects`)).json()) as Project[]
    expect(list.map((p) => p.id)).toEqual([project.id])

    await srv.close()
  })

  it('PATCH /projects/:id renames; DELETE /projects/:id removes', async () => {
    const { srv } = projectServer()
    const { port } = await srv.listen(0)
    const project = (await (await fetch(`http://localhost:${port}/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'old' }),
    })).json()) as Project

    const patch = await fetch(`http://localhost:${port}/projects/${project.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'new' }),
    })
    expect(patch.status).toBe(200)
    const renamed = (await patch.json()) as Project
    expect(renamed.name).toBe('new')

    const del = await fetch(`http://localhost:${port}/projects/${project.id}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect((await del.json()) as { ok: boolean }).toEqual({ ok: true })

    const list = (await (await fetch(`http://localhost:${port}/projects`)).json()) as Project[]
    expect(list).toHaveLength(0)

    await srv.close()
  })

  it('PATCH /projects/:id 404s for an unknown id', async () => {
    const { srv } = projectServer()
    const { port } = await srv.listen(0)
    const patch = await fetch(`http://localhost:${port}/projects/nope`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x' }),
    })
    expect(patch.status).toBe(404)
    await srv.close()
  })

  it('DELETE /projects/:id returns { ok: false } for an unknown id', async () => {
    const { srv } = projectServer()
    const { port } = await srv.listen(0)
    const del = await fetch(`http://localhost:${port}/projects/nope`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect((await del.json()) as { ok: boolean }).toEqual({ ok: false })
    await srv.close()
  })

  it('project endpoints 500 when no project store is configured', async () => {
    const { srv } = projectServer(false)
    const { port } = await srv.listen(0)
    const res = await fetch(`http://localhost:${port}/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'p' }),
    })
    expect(res.status).toBe(500)
    await srv.close()
  })

  it('CORS advertises PATCH + DELETE so a cross-origin SPA can call them', async () => {
    const { srv } = projectServer()
    const { port } = await srv.listen(0)
    const res = await fetch(`http://localhost:${port}/projects`, { method: 'OPTIONS' })
    expect(res.status).toBe(204)
    const methods = res.headers.get('access-control-allow-methods') ?? ''
    expect(methods).toContain('PATCH')
    expect(methods).toContain('DELETE')
    await srv.close()
  })
})

describe('server — projects auth gating + owner scoping', () => {
  it('GET /projects without a token 401s when auth is configured', async () => {
    const github = fakeGithubOAuth({ user: { id: 42, login: 'octocat' } })
    const userStore = jsonUserStore(mkdtempSync(join(tmpdir(), 'srv-proj-gate-user-')))
    const tokenStore = jsonTokenStore(mkdtempSync(join(tmpdir(), 'srv-proj-gate-token-')))
    const projectStore = jsonProjectStore(mkdtempSync(join(tmpdir(), 'srv-proj-gate-proj-')))
    const srv = createServer({
      executor: fakeExecutor(), defaultAgent: 'claude', flows: {}, storeDir: undefined,
      projectStore, auth: { github, userStore, tokenStore, sessionSecret, appBaseUrl },
    })
    const { port } = await srv.listen(0)
    const res = await fetch(`http://localhost:${port}/projects`)
    expect(res.status).toBe(401)
    await srv.close()
  })

  it('projects are scoped per user: B does not see A\'s project, A does', async () => {
    const github = fakeGithubOAuth({ user: { id: 1, login: 'alice' } })
    const userStore = jsonUserStore(mkdtempSync(join(tmpdir(), 'srv-proj-scope-user-')))
    const tokenStore = jsonTokenStore(mkdtempSync(join(tmpdir(), 'srv-proj-scope-token-')))
    const projectStore = jsonProjectStore(mkdtempSync(join(tmpdir(), 'srv-proj-scope-proj-')))
    const srv = createServer({
      executor: fakeExecutor(), defaultAgent: 'claude', flows: {}, storeDir: undefined,
      projectStore, auth: { github, userStore, tokenStore, sessionSecret, appBaseUrl },
    })
    const { port } = await srv.listen(0)
    const mint = async (gh: { id: number; login: string }) => {
      ;(github as { setUser?: (u: { id: number; login: string }) => void }).setUser?.(gh)
      const state = signState(sessionSecret)
      const cb = await fetch(`http://localhost:${port}/auth/callback?code=x&state=${encodeURIComponent(state)}`, { redirect: 'manual' })
      return hashOf(cb.headers.get('location')!).replace('#token=', '')
    }
    const tokenA = await mint({ id: 1, login: 'alice' })
    const tokenB = await mint({ id: 2, login: 'bob' })

    const created = (await (await fetch(`http://localhost:${port}/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ name: 'a-project' }),
    })).json()) as Project
    expect(created.ownerId).toBeTruthy()

    const bList = (await (await fetch(`http://localhost:${port}/projects`, { headers: { authorization: `Bearer ${tokenB}` } })).json()) as Project[]
    expect(bList.map((p) => p.name)).not.toContain('a-project')

    const aList = (await (await fetch(`http://localhost:${port}/projects`, { headers: { authorization: `Bearer ${tokenA}` } })).json()) as Project[]
    expect(aList.map((p) => p.name)).toContain('a-project')

    await srv.close()
  })

  it('/projects works without a token when auth is NOT configured (backward compat)', async () => {
    const projectStore = jsonProjectStore(mkdtempSync(join(tmpdir(), 'srv-proj-noauth-')))
    const srv = createServer({ executor: fakeExecutor(), defaultAgent: 'claude', flows: {}, storeDir: undefined, projectStore })
    const { port } = await srv.listen(0)
    const get = await fetch(`http://localhost:${port}/projects`)
    expect(get.status).toBe(200)
    await srv.close()
  })
})
