/**
 * Runnable backend entrypoint. Boots the HTTP+WS server with a demo flow + loop
 * so the frontend has a live engine to talk to. With RUN_REAL=1 it uses the real
 * `claude -p` executor (costs tokens, uses your logged-in subscription); otherwise
 * the deterministic fake whose reply is keyed to the demo agent prompt.
 *
 *   npm run serve            # fake executor (no tokens)
 *   RUN_REAL=1 npm run serve # real `claude -p`, uses your logged-in subscription
 *
 * The wiring pieces (buildExecutor/demoFlow/flows/seedDemoLoop) are exported so
 * tests can exercise them without binding a port; the listen() side effects only
 * fire when this module is the process entrypoint.
 */
import { fileURLToPath } from 'node:url'
import { createServer } from './server'
import { claudeCliExecutor } from './executor/claudeCli'
import { fakeExecutor } from './executor/fake'
import { jsonLoopStore } from './loop/jsonLoopStore'
import { loopRunner } from './loop/loopRunner'
import { jsonSessionStore } from './session/jsonSessionStore'
import { storeSessionBus } from './session/storeSessionBus'
import type { Executor, Flow } from './types'
import type { LoopStore } from './loop/types'

/** The demo agent prompt; the fake executor's reply is keyed to it for determinism. */
const DEMO_PROMPT = '用一句话友好地跟用户打个招呼,说明你是 Dittos 的 Loop Flow agent。'

/** A tiny one-step flow: greet the user via the default agent and return the greeting. */
export const demoFlow: Flow = async (api) => {
  api.phase('demo')
  api.log('starting demo flow')
  const g = await api.agent(DEMO_PROMPT)
  return g
}

export const flows: Record<string, Flow> = { demo: demoFlow }

/** RUN_REAL=1 → real `claude -p`; otherwise the fake keyed to the demo prompt. */
export function buildExecutor(): Executor {
  const real = process.env.RUN_REAL === '1'
  return real
    ? claudeCliExecutor()
    : fakeExecutor({ replies: { [`claude:${DEMO_PROMPT}`]: { text: '你好!我是 Dittos 的 Loop Flow agent。' } } })
}

/** Seed the demo loop without clobbering an existing one (idempotent across restarts). */
export async function seedDemoLoop(store: LoopStore): Promise<void> {
  const existing = await store.get('demo-loop')
  if (!existing) await store.upsert({ id: 'demo-loop', flow: 'demo', trigger: { kind: 'interval', everyMs: 600000 } })
}

async function main(): Promise<void> {
  const executor = buildExecutor()
  const store = jsonLoopStore(process.env.LOOP_DATA_DIR || './.data/loops')
  const memoryDir = process.env.LOOP_MEMORY_DIR || './.data/memory'
  // Real session layer: loop runs open + mirror their narration into a persisted,
  // project-scoped session; the /sessions endpoints read/write the same store.
  const sessionStore = jsonSessionStore(process.env.SESSION_DATA_DIR || './.data/sessions')
  const sessionBus = storeSessionBus(sessionStore)

  const srv = createServer({
    executor,
    defaultAgent: 'claude',
    flows,
    store,
    sessionStore,
    sessionBus,
    makeRunner: (emit, awaitApproval, sessionBus) => loopRunner({ store, executor, flows, emit, awaitApproval, sessionBus, notify: () => {}, defaultAgent: 'claude', memoryDir }),
  })

  await seedDemoLoop(store)

  const port = Number(process.env.PORT || 8787)
  await srv.listen(port)
  const base = `http://localhost:${port}`
  console.log(`Dittos Loop Flow engine listening on ${base}`)
  console.log(`  GET  ${base}/loops`)
  console.log(`  POST ${base}/loops/:id/trigger`)
  console.log(`  POST ${base}/loops/:id/resume`)
  console.log(`  POST ${base}/sessions`)
  console.log(`  GET  ${base}/sessions`)
  console.log(`  POST ${base}/sessions/:id/messages`)
  console.log(`  GET  ${base}/sessions/:id/messages`)
  console.log(`  WS   ${base.replace('http', 'ws')}/runs/:id/events`)
}

// Only boot when run as the process entrypoint, so importing for tests is side-effect free.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main()
}
