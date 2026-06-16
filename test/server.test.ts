import { describe, it, expect } from 'vitest'
import { createServer } from '../src/server'
import { fakeExecutor } from '../src/executor/fake'
import WebSocket from 'ws'

describe('server', () => {
  it('POST /runs starts a flow and streams its events over WS', async () => {
    const flow = async (api: any) => { api.phase('p'); await api.agent('hi'); return 'ok' }
    const srv = createServer({ executor: fakeExecutor(), defaultAgent: 'claude', flows: { demo: flow }, storeDir: undefined })
    const { port } = await srv.listen(0)
    const res = await fetch(`http://localhost:${port}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ flow: 'demo', args: {} }) })
    const { runId } = await res.json()
    const got: string[] = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}/runs/${runId}/events`)
      const types: string[] = []
      ws.on('message', (d) => { const e = JSON.parse(d.toString()); types.push(e.type); if (e.type === 'run_done') { ws.close(); resolve(types) } })
    })
    expect(got).toContain('run_done')
    await srv.close()
  })
})
