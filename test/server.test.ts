import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { createServer } from '../src/server'
import { fakeExecutor } from '../src/executor/fake'
import { jsonLoopStore } from '../src/loop/jsonLoopStore'
import { loopRunner } from '../src/loop/loopRunner'
import { fakeSessionBus } from '../src/loop/sessionBus'
import type { FakeSessionBus } from '../src/loop/sessionBus'
import type { LoopSpec } from '../src/loop/types'
import type { EngineEvent, Flow } from '../src/types'
import WebSocket from 'ws'

describe('server', () => {
  it('POST /runs starts a flow and streams its events over WS', async () => {
    const flow = async (api: any) => { api.phase('p'); await api.agent('hi'); return 'ok' }
    const srv = createServer({ executor: fakeExecutor(), defaultAgent: 'claude', flows: { demo: flow }, storeDir: undefined })
    const { port } = await srv.listen(0)
    const res = await fetch(`http://localhost:${port}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ flow: 'demo', args: {} }) })
    const { runId } = (await res.json()) as { runId: string }
    const got: string[] = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}/runs/${runId}/events`)
      const types: string[] = []
      ws.on('message', (d) => { const e = JSON.parse(d.toString()); types.push(e.type); if (e.type === 'run_done') { ws.close(); resolve(types) } })
    })
    expect(got).toContain('run_done')
    await srv.close()
  })
})

// ---- Task 6: loop CRUD + trigger + resume ----

const loopSpec = (over: Partial<LoopSpec> = {}): LoopSpec => ({
  id: 'L1', flow: 'demo', trigger: { kind: 'interval', everyMs: 1000 }, ...over,
})

function loopServer(flows: Record<string, Flow>, bus?: FakeSessionBus) {
  const dir = mkdtempSync(join(tmpdir(), 'srv-loop-'))
  const memDir = mkdtempSync(join(tmpdir(), 'srv-mem-'))
  const store = jsonLoopStore(dir)
  const executor = fakeExecutor()
  // The server constructs the runner via makeRunner so the runner's events flow
  // through the server's per-run buffer/WS plumbing (keyed by the run id the runner used).
  const srv = createServer({
    executor,
    defaultAgent: 'claude',
    flows,
    storeDir: undefined,
    store,
    sessionBus: bus,
    makeRunner: (emit: (e: EngineEvent) => void, awaitApproval, sessionBus) =>
      loopRunner({ store, executor, flows, emit, awaitApproval, sessionBus, notify: () => {}, defaultAgent: 'claude', memoryDir: memDir }),
  })
  return { srv, store, dir, memDir }
}

describe('server — loop endpoints', () => {
  it('POST /loops creates+stores a loop, GET /loops lists it with state', async () => {
    const flow: Flow = async () => 'ok'
    const { srv, store } = loopServer({ demo: flow })
    const { port } = await srv.listen(0)

    const create = await fetch(`http://localhost:${port}/loops`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(loopSpec()),
    })
    expect(create.status).toBe(200)

    const stored = await store.get('L1')
    expect(stored?.spec.flow).toBe('demo')
    expect(stored?.state).toMatchObject({ cursor: null, consecutiveFailures: 0, paused: false })

    const list = await fetch(`http://localhost:${port}/loops`)
    const body = (await list.json()) as Array<{ spec: LoopSpec; state: { paused: boolean } }>
    expect(body).toHaveLength(1)
    expect(body[0]?.spec.id).toBe('L1')
    expect(body[0]?.state.paused).toBe(false)

    await srv.close()
  })

  it('POST /loops/:id/trigger runs one tick and streams that run over WS', async () => {
    const flow: Flow = async (api) => { api.phase('p'); await api.agent('hi'); return 'ok' }
    const { srv, store } = loopServer({ demo: flow })
    const { port } = await srv.listen(0)
    await fetch(`http://localhost:${port}/loops`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(loopSpec()),
    })

    const trig = await fetch(`http://localhost:${port}/loops/L1/trigger`, { method: 'POST' })
    const { runId } = (await trig.json()) as { runId: string }
    expect(typeof runId).toBe('string')

    const types: string[] = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}/runs/${runId}/events`)
      const seen: string[] = []
      ws.on('message', (d) => { const e = JSON.parse(d.toString()); seen.push(e.type); if (e.type === 'run_done') { ws.close(); resolve(seen) } })
    })
    expect(types).toContain('agent_started')
    expect(types).toContain('run_done')

    // tick ran: lastRunAt recorded
    const stored = await store.get('L1')
    expect(stored?.state.lastRunAt).toBeTypeOf('number')

    await srv.close()
  })

  it('POST /loops/:id/trigger opens a session via the configured sessionBus', async () => {
    const flow: Flow = async (api) => { api.log('working'); return 'ok' }
    const bus = fakeSessionBus()
    const { srv } = loopServer({ demo: flow }, bus)
    const { port } = await srv.listen(0)
    await fetch(`http://localhost:${port}/loops`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(loopSpec({ projectId: 'proj-1' })),
    })

    const trig = await fetch(`http://localhost:${port}/loops/L1/trigger`, { method: 'POST' })
    const { runId } = (await trig.json()) as { runId: string }

    // drain the run so the manual-trigger session lifecycle completes before we assert
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}/runs/${runId}/events`)
      ws.on('message', (d) => { const e = JSON.parse(d.toString()); if (e.type === 'run_done') { ws.close(); resolve() } })
    })

    const created = bus.calls.find((c) => c.kind === 'create')
    expect(created).toMatchObject({ kind: 'create', projectId: 'proj-1' })
    const posts = bus.calls.filter((c) => c.kind === 'post').map((c) => (c as { text: string }).text)
    expect(posts.some((t) => t.includes('你手动触发'))).toBe(true)

    await srv.close()
  })

  it('POST /loops/:id/resume clears paused + resets failures', async () => {
    const flow: Flow = async () => 'ok'
    const { srv, store } = loopServer({ demo: flow })
    const { port } = await srv.listen(0)
    await fetch(`http://localhost:${port}/loops`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(loopSpec()),
    })
    await store.setState('L1', { paused: true, pausedReason: 'failures', consecutiveFailures: 3 })

    const resume = await fetch(`http://localhost:${port}/loops/L1/resume`, { method: 'POST' })
    expect(resume.status).toBe(200)

    const stored = await store.get('L1')
    expect(stored?.state.paused).toBe(false)
    expect(stored?.state.consecutiveFailures).toBe(0)
    expect(stored?.state.pausedReason).toBeUndefined()

    await srv.close()
  })

  it('POST /loops/:id/trigger on an unknown loop 404s', async () => {
    const { srv } = loopServer({ demo: async () => 'ok' })
    const { port } = await srv.listen(0)
    const res = await fetch(`http://localhost:${port}/loops/nope/trigger`, { method: 'POST' })
    expect(res.status).toBe(404)
    await srv.close()
  })
})

describe('server — approvals', () => {
  it('POST /runs/:id/approvals/:approvalId resolves a gate so the run completes', async () => {
    // A flow that blocks on a human gate; the WS-driven POST below is what lets it finish.
    const flow: Flow = async (api) => { const r = await api.approval('proceed?'); return `done:${r.decision}` }
    const srv = createServer({ executor: fakeExecutor(), defaultAgent: 'claude', flows: { gated: flow }, storeDir: undefined })
    const { port } = await srv.listen(0)

    const res = await fetch(`http://localhost:${port}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ flow: 'gated', args: {} }) })
    const { runId } = (await res.json()) as { runId: string }

    let approvePost: Response | undefined
    const types: string[] = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}/runs/${runId}/events`)
      const seen: string[] = []
      ws.on('message', (d) => {
        const e = JSON.parse(d.toString())
        seen.push(e.type)
        if (e.type === 'approval_requested') {
          // Until this POST lands the run must stay parked on the gate (server-wired awaitApproval).
          expect(seen).not.toContain('approval_resolved')
          void fetch(`http://localhost:${port}/runs/${runId}/approvals/${e.approvalId}`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approve' }),
          }).then((r) => { approvePost = r })
        }
        if (e.type === 'run_done') { ws.close(); resolve(seen) }
      })
    })

    expect(approvePost?.status).toBe(200)
    expect(types).toContain('approval_requested')
    expect(types).toContain('approval_resolved')
    expect(types).toContain('run_done')

    await srv.close()
  })

  it('POST /runs/:id/approvals/:approvalId 404s when no approval is pending', async () => {
    const srv = createServer({ executor: fakeExecutor(), defaultAgent: 'claude', flows: { demo: async () => 'ok' }, storeDir: undefined })
    const { port } = await srv.listen(0)
    const res = await fetch(`http://localhost:${port}/runs/nope/approvals/nope`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approve' }),
    })
    expect(res.status).toBe(404)
    await srv.close()
  })
})

describe('server — CORS', () => {
  it('OPTIONS /loops short-circuits as a 204 preflight with permissive CORS headers', async () => {
    const { srv } = loopServer({ demo: async () => 'ok' })
    const { port } = await srv.listen(0)

    const res = await fetch(`http://localhost:${port}/loops`, { method: 'OPTIONS' })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-allow-methods')).toContain('GET')
    expect(res.headers.get('access-control-allow-methods')).toContain('POST')
    expect(res.headers.get('access-control-allow-methods')).toContain('OPTIONS')
    expect(res.headers.get('access-control-allow-headers')).toContain('content-type')

    await srv.close()
  })

  it('GET /loops carries access-control-allow-origin so a cross-origin browser can read it', async () => {
    const { srv } = loopServer({ demo: async () => 'ok' })
    const { port } = await srv.listen(0)

    const res = await fetch(`http://localhost:${port}/loops`)
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')

    await srv.close()
  })
})
