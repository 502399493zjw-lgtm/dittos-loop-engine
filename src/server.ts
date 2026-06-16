import http from 'node:http'
import { WebSocketServer } from 'ws'
import { randomUUID } from 'node:crypto'
import { runFlow } from './engine/runtime'
import { jsonStore } from './store/jsonStore'
import type { EngineEvent, Executor, Flow } from './types'

export function createServer(cfg: { executor: Executor; defaultAgent: string; flows: Record<string, Flow>; storeDir?: string }) {
  const store = cfg.storeDir ? jsonStore(cfg.storeDir) : undefined
  // live subscribers + buffered events per run (P1: in-memory; store is the durable copy)
  const subs = new Map<string, Set<(e: EngineEvent) => void>>()
  const buffer = new Map<string, EngineEvent[]>()

  function emitFor(runId: string) {
    return (e: EngineEvent) => {
      (buffer.get(runId) ?? buffer.set(runId, []).get(runId)!).push(e)
      void store?.append(runId, e)
      for (const fn of subs.get(runId) ?? []) fn(e)
    }
  }

  const httpServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/runs') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
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
