import http from 'node:http'
import { WebSocketServer } from 'ws'
import { randomUUID } from 'node:crypto'
import { runFlow } from './engine/runtime'
import { jsonStore } from './store/jsonStore'
import type { EngineEvent, Executor, Flow, ApprovalRequest, ApprovalResult } from './types'
import type { LoopSpec, LoopStore } from './loop/types'
import type { LoopRunner } from './loop/loopRunner'
import type { SessionBus } from './loop/sessionBus'

export interface ServerConfig {
  executor: Executor
  defaultAgent: string
  flows: Record<string, Flow>
  storeDir?: string
  /** Loop persistence; required for the /loops endpoints. */
  store?: LoopStore
  /**
   * When set, each loop run opens a fresh chat session under its project and
   * auto-mirrors its narration into it; forwarded into the runner via makeRunner.
   */
  sessionBus?: SessionBus
  /**
   * Build the loop runner, wiring its event sink so a loop's run events flow
   * through the same per-run buffer/WS plumbing as ad-hoc /runs. The runner
   * picks the run id internally; the server keys events by `e.runId`.
   * `awaitApproval` is forwarded so loop-triggered runs honour the same gates as /runs.
   * `sessionBus` (from cfg) is forwarded so loop runs can open + mirror to sessions.
   */
  makeRunner?: (emit: (e: EngineEvent) => void, awaitApproval: (req: ApprovalRequest) => Promise<ApprovalResult>, sessionBus?: SessionBus) => LoopRunner
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => resolve(body))
  })
}

export function createServer(cfg: ServerConfig) {
  const runStore = cfg.storeDir ? jsonStore(cfg.storeDir) : undefined
  // live subscribers + buffered events per run (P1: in-memory; store is the durable copy)
  const subs = new Map<string, Set<(e: EngineEvent) => void>>()
  const buffer = new Map<string, EngineEvent[]>()

  function emitFor(runId: string) {
    return (e: EngineEvent) => {
      (buffer.get(runId) ?? buffer.set(runId, []).get(runId)!).push(e)
      void runStore?.append(runId, e)
      for (const fn of subs.get(runId) ?? []) fn(e)
    }
  }

  // FIFO captures awaiting the run id of the next loop run. A trigger registers a
  // capture, then calls runner.tick(); the first `run_started` it sees resolves it.
  const pendingRunIds: Array<(runId: string) => void> = []

  // The runner's events are routed by their own runId (set inside runFlow). The
  // first event of any run (`run_started`) also satisfies the oldest pending capture.
  const runnerEmit = (e: EngineEvent) => {
    if (e.type === 'run_started') {
      const resolve = pendingRunIds.shift()
      if (resolve) resolve(e.runId)
    }
    emitFor(e.runId)(e)
  }

  // Parked approval gates keyed by `${runId}:${approvalId}`. api.approval's awaitApproval
  // registers a resolver here; the POST /runs/:id/approvals/:id route fulfils it.
  const pendingApprovals = new Map<string, (r: ApprovalResult) => void>()
  const makeAwaitApproval = () => (req: ApprovalRequest) =>
    new Promise<ApprovalResult>((resolve) => pendingApprovals.set(`${req.runId}:${req.approvalId}`, resolve))

  const runner = cfg.makeRunner?.(runnerEmit, makeAwaitApproval(), cfg.sessionBus)

  const httpServer = http.createServer((req, res) => {
    const url = req.url ?? ''
    const method = req.method ?? 'GET'

    // ---- CORS: permissive so a browser frontend on another origin can call the API ----
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS')
    res.setHeader('access-control-allow-headers', 'content-type')
    if (method === 'OPTIONS') { res.writeHead(204).end(); return } // preflight

    // ---- P1: ad-hoc run ----
    if (method === 'POST' && url === '/runs') {
      void readBody(req).then((body) => {
        const { flow, args } = JSON.parse(body || '{}')
        const f = cfg.flows[flow]
        if (!f) { res.writeHead(404).end('unknown flow'); return }
        const runId = randomUUID()
        buffer.set(runId, [])
        res.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ runId }))
        void runFlow(f, { runId, executor: cfg.executor, defaultAgent: cfg.defaultAgent, args, awaitApproval: makeAwaitApproval(), emit: emitFor(runId) })
      })
      return
    }

    // ---- resolve a parked approval gate (CORS headers above cover this route) ----
    const approve = /^\/runs\/([^/]+)\/approvals\/([^/]+)$/.exec(url)
    if (method === 'POST' && approve) {
      const runId = approve[1]!
      const approvalId = approve[2]!
      void readBody(req).then((body) => {
        const { decision, note } = JSON.parse(body || '{}') as { decision?: string; note?: string }
        const key = `${runId}:${approvalId}`
        const resolve = pendingApprovals.get(key)
        if (!resolve) { res.writeHead(404).end('no pending approval'); return }
        pendingApprovals.delete(key)
        resolve({ decision: decision ?? 'approve', note })
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }))
      })
      return
    }

    // ---- P2: loop CRUD ----
    if (method === 'POST' && url === '/loops') {
      if (!cfg.store) { res.writeHead(500).end('no loop store'); return }
      void readBody(req).then(async (body) => {
        const spec = JSON.parse(body || '{}') as LoopSpec
        if (!spec.id || !spec.flow) { res.writeHead(400).end('invalid loop spec'); return }
        await cfg.store!.upsert(spec)
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: spec.id }))
      })
      return
    }

    if (method === 'GET' && url === '/loops') {
      if (!cfg.store) { res.writeHead(500).end('no loop store'); return }
      void cfg.store.list().then((loops) => {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(loops))
      })
      return
    }

    const trigger = /^\/loops\/([^/]+)\/trigger$/.exec(url)
    if (method === 'POST' && trigger) {
      const id = trigger[1]!
      if (!cfg.store || !runner) { res.writeHead(500).end('no loop runner'); return }
      void cfg.store.get(id).then((loaded) => {
        if (!loaded) { res.writeHead(404).end('unknown loop'); return }
        // Register the capture BEFORE ticking so the run's first event maps to this request.
        const runIdReady = new Promise<string>((resolve) => pendingRunIds.push(resolve))
        void runner.tick(id, { kind: 'manual' }) // fire-and-forget; events stream over WS
        void runIdReady.then((runId) => {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ runId }))
        })
      })
      return
    }

    const resume = /^\/loops\/([^/]+)\/resume$/.exec(url)
    if (method === 'POST' && resume) {
      const id = resume[1]!
      if (!cfg.store) { res.writeHead(500).end('no loop store'); return }
      void cfg.store.get(id).then(async (loaded) => {
        if (!loaded) { res.writeHead(404).end('unknown loop'); return }
        await cfg.store!.setState(id, { paused: false, consecutiveFailures: 0, pausedReason: undefined })
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id }))
      })
      return
    }

    res.writeHead(404).end()
  })

  const wss = new WebSocketServer({ server: httpServer })
  wss.on('connection', (ws, req) => {
    const m = /\/runs\/([^/]+)\/events/.exec(req.url ?? '')
    if (!m) { ws.close(); return }
    const runId = m[1]
    if (!runId) { ws.close(); return }
    for (const e of buffer.get(runId) ?? []) ws.send(JSON.stringify(e)) // replay so late joiners catch up
    const fn = (e: EngineEvent) => ws.send(JSON.stringify(e))
    ;(subs.get(runId) ?? subs.set(runId, new Set()).get(runId)!).add(fn)
    ws.on('close', () => subs.get(runId)?.delete(fn))
  })

  return {
    listen: (port: number) => new Promise<{ port: number }>((resolve) => httpServer.listen(port, () => resolve({ port: (httpServer.address() as { port: number }).port }))),
    close: () => new Promise<void>((resolve) => { wss.close(); httpServer.close(() => resolve()) }),
  }
}
