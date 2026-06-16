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
import { createHash } from 'node:crypto'
import { createServer } from './server'
import { claudeCliExecutor } from './executor/claudeCli'
import { fakeExecutor } from './executor/fake'
import { daemonHub } from './daemon/daemonHub'
import { daemonExecutor } from './daemon/daemonExecutor'
import { jsonLoopStore } from './loop/jsonLoopStore'
import { loopRunner } from './loop/loopRunner'
import { jsonSessionStore } from './session/jsonSessionStore'
import { jsonProjectStore } from './project/jsonProjectStore'
import { storeSessionBus } from './session/storeSessionBus'
import { jsonTurnStore } from './chat/turnStore'
import { jsonTraceStore } from './chat/traceStore'
import { claudeStreamExecutor } from './chat/streamExecutor'
import { githubOAuth } from './auth/github'
import { jsonUserStore } from './auth/jsonUserStore'
import { jsonTokenStore } from './auth/jsonTokenStore'
import type { Executor, Flow } from './types'
import type { LoopStore } from './loop/types'
import type { ServerConfig } from './server'
import type { StreamExecutor } from './chat/streamExecutor'
import type { DaemonHub } from './daemon/daemonHub'

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

/** The daemon-mode wiring: one remote executor serving BOTH seams + the WS auth config. */
export interface DaemonWiring {
  hub: DaemonHub
  /** Loop executor (Executor seam) — the same daemon executor object. */
  executor: Executor
  /** Chat stream executor (StreamExecutor seam) — the same daemon executor object. */
  streamExecutor: StreamExecutor
  /** ServerConfig.daemon: the hub the /daemon/ws endpoint registers conns into + the token hash. */
  daemon: NonNullable<ServerConfig['daemon']>
}

/**
 * DAEMON_MODE=1 (prod): the engine must NOT run `claude` (spec §3). Build a
 * daemonHub + daemonExecutor and return it wired as BOTH the loop `executor` and
 * the chat `streamExecutor` (the daemonExecutor object satisfies both seams), plus
 * ServerConfig.daemon = { hub, tokenHash: sha256(DAEMON_TOKEN) } so the /daemon/ws
 * endpoint can auth + register the local daemon's conn into the same hub the
 * executor dispatches over. When DAEMON_MODE is unset → undefined (local dev keeps
 * the in-process claude executors).
 */
export function buildDaemonWiring(): DaemonWiring | undefined {
  if (process.env.DAEMON_MODE !== '1') return undefined
  const hub = daemonHub()
  const ex = daemonExecutor(hub)
  const tokenHash = createHash('sha256').update(process.env.DAEMON_TOKEN ?? '').digest('hex')
  return { hub, executor: ex, streamExecutor: ex, daemon: { hub, tokenHash } }
}

/**
 * Build the GitHub-OAuth auth config from env, but ONLY when GITHUB_CLIENT_ID is
 * set. Open-source deployers bring their own GitHub app via env; with no app
 * configured (dev) auth stays off and the /auth/* surface is absent.
 */
export function buildAuthConfig(): ServerConfig['auth'] | undefined {
  if (!process.env.GITHUB_CLIENT_ID) return undefined
  const github = githubOAuth({
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
    callbackUrl: process.env.GITHUB_CALLBACK_URL || '',
  })
  return {
    github,
    userStore: jsonUserStore(process.env.AUTH_DATA_DIR || './.data/users'),
    tokenStore: jsonTokenStore(process.env.AUTH_DATA_DIR || './.data/tokens'),
    sessionSecret: process.env.SESSION_SECRET || 'dev-secret',
    appBaseUrl: process.env.APP_BASE_URL || 'http://localhost:5173',
  }
}

/** Seed the demo loop without clobbering an existing one (idempotent across restarts). */
export async function seedDemoLoop(store: LoopStore): Promise<void> {
  const existing = await store.get('demo-loop')
  if (!existing) await store.upsert({ id: 'demo-loop', flow: 'demo', trigger: { kind: 'interval', everyMs: 600000 } })
}

async function main(): Promise<void> {
  // Prod (DAEMON_MODE=1): the engine never runs `claude` — a local daemon does,
  // linked over /daemon/ws. The daemonExecutor (one object) is wired as BOTH the
  // loop executor AND the chat streamExecutor. Local dev (unset): in-process
  // claude executors (claudeCli/claudeStream), unchanged.
  const daemonWiring = buildDaemonWiring()
  const executor = daemonWiring ? daemonWiring.executor : buildExecutor()
  if (daemonWiring) console.log('mode: DAEMON_MODE — agent runs on the linked local daemon (engine runs no claude)')
  else console.log('mode: local — in-process claude executor')
  const store = jsonLoopStore(process.env.LOOP_DATA_DIR || './.data/loops')
  const memoryDir = process.env.LOOP_MEMORY_DIR || './.data/memory'
  // Real session layer: loop runs open + mirror their narration into a persisted,
  // project-scoped session; the /sessions endpoints read/write the same store.
  const sessionStore = jsonSessionStore(process.env.SESSION_DATA_DIR || './.data/sessions')
  const sessionBus = storeSessionBus(sessionStore)
  // Project layer: a named owner-scoped container the frontend uses to group
  // sessions; the /projects endpoints read/write this store.
  const projectStore = jsonProjectStore(process.env.PROJECT_DATA_DIR || './.data/projects')
  // Chat slice: turn + trace stores (JSON under ./.data) + the real `claude -p
  // stream-json` executor. Together with sessionStore they enable /channels +
  // /turns and the per-channel WS (spec §1-§3).
  const turnStore = jsonTurnStore(process.env.TURN_DATA_DIR || './.data/turns')
  const traceStore = jsonTraceStore(process.env.TRACE_DATA_DIR || './.data/trace')
  // In DAEMON_MODE the chat stream goes to the daemon too; else the in-process claude stream.
  const streamExecutor = daemonWiring ? daemonWiring.streamExecutor : claudeStreamExecutor()
  const auth = buildAuthConfig()

  const srv = createServer({
    executor,
    defaultAgent: 'claude',
    flows,
    store,
    sessionStore,
    projectStore,
    sessionBus,
    turnStore,
    traceStore,
    streamExecutor,
    ...(daemonWiring ? { daemon: daemonWiring.daemon } : {}),
    ...(auth ? { auth } : {}),
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
  console.log(`  GET  ${base}/projects`)
  console.log(`  POST ${base}/projects`)
  console.log(`  PATCH  ${base}/projects/:id`)
  console.log(`  DELETE ${base}/projects/:id`)
  console.log(`  POST ${base}/sessions/:id/messages`)
  console.log(`  GET  ${base}/sessions/:id/messages`)
  console.log(`  POST ${base}/channels/:id/messages`)
  console.log(`  GET  ${base}/channels/:id/messages`)
  console.log(`  GET  ${base}/channels/:id/turns`)
  console.log(`  GET  ${base}/turns/:id`)
  console.log(`  GET  ${base}/turns/:id/events`)
  console.log(`  WS   ${base.replace('http', 'ws')}/runs/:id/events`)
  console.log(`  WS   ${base.replace('http', 'ws')}/channels/:id/events`)
}

// Only boot when run as the process entrypoint, so importing for tests is side-effect free.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main()
}
