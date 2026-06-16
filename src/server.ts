import http from 'node:http'
import { WebSocketServer } from 'ws'
import { randomUUID } from 'node:crypto'
import { runFlow } from './engine/runtime'
import { jsonStore } from './store/jsonStore'
import type { EngineEvent, Executor, Flow } from './types'
import type { LoopSpec, LoopStore } from './loop/types'
import type { LoopRunner } from './loop/loopRunner'

export interface ServerConfig {
  executor: Executor
  defaultAgent: string
  flows: Record<string, Flow>
  storeDir?: string
  /** Loop persistence; required for the /loops endpoints. */
  store?: LoopStore
  /**
   * Build the loop runner, wiring its event sink so a loop's run events flow
   * through the same per-run buffer/WS plumbing as ad-hoc /runs. The runner
   * picks the run id internally; the server keys events by `e.runId`.
   */
  makeRunner?: (emit: (e: EngineEvent) => void) => LoopRunner
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

  const runner = cfg.makeRunner?.(runnerEmit)

  const httpServer = http.createServer((req, res) => {
    const url = req.url ?? ''
    const method = req.method ?? 'GET'

    // ---- P1: ad-hoc run ----
    if (method === 'POST' && url === '/runs') {
      void readBody(req).then((body) => {
        const { flow, args } = JSON.parse(body || '{}')
        const f = cfg.flows[flow]
        if (!f) { res.writeHead(404).end('unknown flow'); return }
        const runId = randomUUID()
        buffer.set(runId, [])
        res.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ runId }))
        void runFlow(f, { runId, executor: cfg.executor, defaultAgent: cfg.defaultAgent, args, emit: emitFor(runId) })
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
        void runner.tick(id) // fire-and-forget; events stream over WS
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
