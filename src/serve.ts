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
import { daemonHub } from './daemon/daemonHub'
import { daemonExecutor } from './daemon/daemonExecutor'
import { jsonDaemonTokenStore } from './daemon/daemonTokenStore'
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
import { runBody } from './loop/executionBody'
import type { Executor, Flow } from './types'
import type { LoopStore, LoopSpec, ExecutionBody } from './loop/types'
import type { ServerConfig } from './server'
import type { StreamExecutor } from './chat/streamExecutor'
import type { DaemonHub } from './daemon/daemonHub'

/** The demo agent prompt; the fake executor's reply is keyed to it for determinism. */
const DEMO_PROMPT = '用一句话友好地跟用户打个招呼,说明你是 Dittos 的 Live Loop agent。'

/** A tiny one-step flow: greet the user via the default agent and return the greeting. */
export const demoFlow: Flow = async (api) => {
  api.phase('demo')
  api.log('starting demo flow')
  const g = await api.agent(DEMO_PROMPT)
  return g
}

/**
 * A representative multi-phase "用户群反馈" loop flow, mirroring the promo video's
 * logic: scan+classify → process (parallel drafts) → summary. There is NO
 * in-flow approval gate — per the loop design, escalation is handled at the loop
 * level instead. Each api.agent() is a real model turn (via the linked daemon in
 * prod). Prompts are self-contained (sample feedback inline) so no tools/
 * connectors are needed, and ask for short outputs so the work-cards stay
 * readable.
 */
const FEEDBACK_BATCH = [
  '买家A：项链戴了一周扣环就松了，能换吗？',
  '买家B：你们有没有情侣对戒款式？',
  '买家C：下单五天了物流还没更新，太慢了。',
  '买家D：手机上打开预览页面是空白的。',
]

export const feedbackFlow: Flow = async (api) => {
  api.phase('扫描归类')
  api.log(`读取 ${FEEDBACK_BATCH.length} 条用户反馈`)
  const classified = await api.agent(
    `把下面的用户反馈按类别归类（咨询 / 退换 / 物流 / Bug）。每条输出一行，格式"类别：原话摘要"，不要解释：\n${FEEDBACK_BATCH.join('\n')}`,
    { label: '归类' },
  )

  api.phase('处理')
  const [reply, bugNote] = await api.parallel([
    () => api.agent('针对"项链扣环松了想换货"的买家，写一条 50 字以内、共情并给出下一步的中文客服回复。只输出回复正文。', { label: '退换草稿' }),
    () => api.agent('把"手机打开预览页面空白"这个 bug 整理成一句给工程师的复现要点。只输出这一句。', { label: 'Bug 整理' }),
  ])

  // No in-flow approval gate: per the loop design, escalation is handled at the
  // loop level (a loop-level escalation boundary replaces the old per-flow gate),
  // so shipped loop flows run end-to-end without parking for human approval.
  api.log('(本轮如涉及升级边界，留待 loop 升级处理)')

  api.phase('汇总')
  // Each api.agent() is a stateless turn, so the summary agent only knows what
  // we hand it — thread the prior results into the prompt explicitly.
  const summary = await api.agent(
    [
      '下面是本轮用户反馈处理的结果。请用两行中文写一句话简报，不要多余解释：',
      '第一行：归类概况；第二行：客服草稿要点。',
      `【归类】\n${String(classified)}`,
      `【退换草稿】\n${String(reply ?? '')}`,
      `【Bug 复现】\n${String(bugNote ?? '')}`,
    ].join('\n\n'),
    { label: '日报' },
  )
  return { classified, reply, bugNote, summary }
}

/**
 * The generic, conversationally-created Live Loop flow. A loop made via
 * `POST /loops/from-session` carries its per-round task in `spec.instructions`
 * (threaded into `api.args` by the runner); each cycle this flow just runs that
 * task as one agent turn. This is what lets users create loops by chatting —
 * no bespoke flow code per loop.
 */
export const agentLoopFlow: Flow = async (api) => {
  const args = (api.args ?? {}) as { instructions?: string; name?: string }
  const task = (args.instructions ?? '').trim() || '（本轮没有具体任务说明）'
  api.phase('执行')
  api.log(`Live Loop「${args.name ?? '未命名'}」本轮执行`)
  const out = await api.agent(
    [
      '你是一个按计划自动运行的 Live Loop agent。下面是这一轮要完成的任务：',
      task,
      '请直接完成任务并给出结果（简洁、可直接交付，不要复述任务本身）。',
    ].join('\n\n'),
    { label: '执行' },
  )
  return out
}

/**
 * The 乙 contract flow — the canonical per-tick runtime for the unified Loop model
 * (spec §6). It receives the loop *contract* in `api.args.contract`; each tick it:
 *
 *   1. builds an escalation preamble from `contract.escalation` (prompt-guidance
 *      only in v1 — auto-pause is a later iteration);
 *   2. asks the agent for *this run's* execution body, seeded by the stored body
 *      (the PLAN step). Usually the agent returns the stored body verbatim; only
 *      when the situation calls for it does it adapt (add/remove/edit steps);
 *   3. runs whichever body it got via `runBody`;
 *   4. returns `{ adapted, body }` so a later adopt-run flow can persist the
 *      adapted body on the user's consent (decision #4).
 *
 * `adapted` is detected purely structurally: parse the first `{...}` JSON
 * substring from the plan reply; if parsing fails OR the parsed body is
 * deep-equal (via stable `JSON.stringify`) to the stored body → run the stored
 * body, `adapted=false`; otherwise run the parsed body, `adapted=true`.
 *
 * Legacy fallback: a contract with no stored body runs `contract.instructions`
 * (or a default) as ONE agent call and returns its text — preserving the thin
 * `agentLoop`-style behaviour for old minimal specs.
 */
export const contractFlow: Flow = async (api) => {
  const args = (api.args ?? {}) as { contract?: LoopSpec; reason?: string; cursor?: unknown }
  const contract = args.contract
  const stored = contract?.body

  // Escalation preamble (spec §6, decision #3): prompt-guidance only in v1.
  const escalation = contract?.escalation ?? []
  const preamble = escalation.length
    ? '升级边界——不要越过；若本轮任务需要其中之一，停下并说明，不要擅自执行：\n' +
      escalation.map((e) => `- ${e}`).join('\n')
    : ''
  const withPreamble = (p: string): string => (preamble ? `${preamble}\n\n${p}` : p)

  // Legacy fallback: no stored body → run the (legacy) instructions as one turn.
  if (!stored) {
    const task = (contract?.instructions ?? '').trim() || '（本轮没有具体任务说明）'
    api.phase('执行')
    const out = await api.agent(
      withPreamble(
        [
          '你是一个按计划自动运行的 Loop agent。下面是这一轮要完成的任务：',
          task,
          '请直接完成任务并给出结果（简洁、可直接交付，不要复述任务本身）。',
        ].join('\n\n'),
      ),
      { label: '执行' },
    )
    return out
  }

  // PLAN STEP (乙): ask for THIS run's body, seeded by the stored body.
  const planText = await api.agent(
    withPreamble(
      '这是已固化的执行剧本(JSON ExecutionBody)：' +
        JSON.stringify(stored) +
        '\n本轮触发原因：' +
        (args.reason ?? '') +
        '\n请返回"这一轮"要执行的剧本，JSON，形如 {"steps":[{"id","kind":"agent|parallel|phase","label","prompt?","children?"}]}。通常原样返回；只有当情况确实需要时才微调(增/删/改步骤)。只输出 JSON，不要任何解释。',
    ),
    { label: '计划' },
  )

  // Detect adaptation: parse the first {...} substring; compare to the stored body.
  const planned = parseFirstJson(typeof planText === 'string' ? planText : JSON.stringify(planText))
  let planToRun: ExecutionBody
  let adapted: boolean
  if (!planned || JSON.stringify(planned) === JSON.stringify(stored)) {
    planToRun = stored
    adapted = false
  } else {
    planToRun = planned as ExecutionBody
    adapted = true
  }

  await runBody(planToRun, api)

  return { adapted, body: planToRun }
}

/** Extract + parse the first `{...}` JSON object substring from a model reply. */
function parseFirstJson(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return undefined
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
}

export const flows: Record<string, Flow> = { demo: demoFlow, feedback: feedbackFlow, agentLoop: agentLoopFlow, contract: contractFlow }

/** RUN_REAL=1 → real `claude -p`; otherwise the fake keyed to the demo prompt. */
export function buildExecutor(): Executor {
  const real = process.env.RUN_REAL === '1'
  return real
    ? claudeCliExecutor()
    : fakeExecutor({ replies: { [`claude:${DEMO_PROMPT}`]: { text: '你好!我是 Dittos 的 Live Loop agent。' } } })
}

/** The daemon-mode wiring: one remote executor serving BOTH seams + the WS auth config. */
export interface DaemonWiring {
  hub: DaemonHub
  /** Loop executor (Executor seam) — the same daemon executor object. */
  executor: Executor
  /** Chat stream executor (StreamExecutor seam) — the same daemon executor object. */
  streamExecutor: StreamExecutor
  /** ServerConfig.daemon: the hub the /daemon/ws endpoint registers conns into + the per-user token store. */
  daemon: NonNullable<ServerConfig['daemon']>
}

/**
 * DAEMON_MODE=1 (prod): the engine must NOT run `claude` (spec §1). Build a
 * daemonHub + daemonExecutor and return it wired as BOTH the loop `executor` and
 * the chat `streamExecutor` (the daemonExecutor object satisfies both seams), plus
 * ServerConfig.daemon = { hub, daemonTokenStore } so the /daemon/ws endpoint can
 * resolve a per-user `?token=` to its userId + register the local daemon's conn
 * (keyed by userId) into the same hub the executor dispatches over. When
 * DAEMON_MODE is unset → undefined (local dev keeps the in-process claude executors).
 */
export function buildDaemonWiring(): DaemonWiring | undefined {
  if (process.env.DAEMON_MODE !== '1') return undefined
  const hub = daemonHub()
  const ex = daemonExecutor(hub)
  const daemonTokenStore = jsonDaemonTokenStore(process.env.DAEMON_DATA_DIR || './.data/daemon-tokens')
  return { hub, executor: ex, streamExecutor: ex, daemon: { hub, daemonTokenStore } }
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
