import http from 'node:http'
import { WebSocketServer } from 'ws'
import { randomUUID } from 'node:crypto'
import { runFlow } from './engine/runtime'
import { jsonStore } from './store/jsonStore'
import type { EngineEvent, Executor, Flow, ApprovalRequest, ApprovalResult } from './types'
import type { LoopSpec, LoopStore } from './loop/types'
import type { LoopRunner } from './loop/loopRunner'
import type { SessionBus } from './loop/sessionBus'
import type { SessionStore } from './session/types'
import type { TurnStore, TraceStore } from './chat/types'
import type { StreamExecutor } from './chat/streamExecutor'
import { respondToMessage } from './chat/respond'
import type { GithubOAuth } from './auth/github'
import type { UserStore, TokenStore } from './auth/types'
import { signState, verifyState } from './auth/state'

export interface ServerConfig {
  executor: Executor
  defaultAgent: string
  flows: Record<string, Flow>
  storeDir?: string
  /** Loop persistence; required for the /loops endpoints. */
  store?: LoopStore
  /** Session/chat persistence; required for the /sessions endpoints. */
  sessionStore?: SessionStore
  /**
   * Chat slice (standalone-chat wire contract, spec §1-§3). The /channels +
   * /turns endpoints and the per-channel WS are enabled when turnStore +
   * traceStore + streamExecutor are all set (alongside sessionStore). When any
   * is unset the chat surface is absent (those routes 500) — the /sessions
   * surface and everything else are unaffected.
   */
  turnStore?: TurnStore
  traceStore?: TraceStore
  streamExecutor?: StreamExecutor
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
  /**
   * GitHub-OAuth bearer auth. When set, the /auth/* endpoints are mounted and
   * tokens are minted on callback. When unset (dev), no auth surface exists.
   */
  auth?: {
    github: GithubOAuth
    userStore: UserStore
    tokenStore: TokenStore
    sessionSecret: string
    appBaseUrl: string
  }
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

  // Chat is enabled when the session + turn + trace stores and a stream executor
  // are all wired. The /channels + /turns REST and the per-channel WS gate on this.
  const chatEnabled = !!(cfg.sessionStore && cfg.turnStore && cfg.traceStore && cfg.streamExecutor)

  // Per-channel WS subscribers for the chat wire envelopes (new_message /
  // turn:created / turn:update / trace:* / msg:chunk). A subscriber records
  // whether it opted into trace (subscribe_trace) so trace:* only goes to
  // those who asked; all other envelopes go to every channel subscriber.
  type ChatSink = { send: (type: string, payload: unknown) => void; trace: boolean }
  const chatSubs = new Map<string, Set<ChatSink>>()
  // trace:* only goes to subscribers who opted into subscribe_trace.
  const TRACE_TYPES = new Set(['trace:batch', 'trace:event'])
  // The "trace v2" envelope family the frontend dispatches as a NESTED
  // { type, payload } (turn:* / trace:* / msg:chunk). new_message stays FLAT.
  const V2_ENVELOPE_TYPES = new Set([
    'turn:created', 'turn:update', 'trace:event', 'trace:batch', 'msg:chunk',
  ])

  // The emit sink handed to respondToMessage for one channel: fan the envelope
  // out to that channel's live WS subscribers (trace gated by subscribe_trace).
  function emitForChannel(channelId: string) {
    return (type: string, payload: unknown) => {
      for (const sink of chatSubs.get(channelId) ?? []) {
        if (TRACE_TYPES.has(type) && !sink.trace) continue
        sink.send(type, payload)
      }
    }
  }

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

  // Bearer auth: resolve `Authorization: Bearer <t>` -> userId, or write 401.
  // Returns the userId on success, or undefined after responding 401. The /loops
  // and /sessions surfaces gate on this when cfg.auth is set; /auth/* stay public,
  // and when cfg.auth is unset there is no gate at all (dev path unchanged).
  async function resolveUserOr401(req: http.IncomingMessage, res: http.ServerResponse): Promise<string | undefined> {
    const header = req.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
    const userId = token ? await cfg.auth!.tokenStore.resolve(token) : undefined
    if (!userId) { res.writeHead(401).end(); return undefined }
    return userId
  }

  // Paths gated by bearer auth (only when cfg.auth is set): /loops + /sessions +
  // the chat surface (/channels + /turns) and their sub-routes. /auth/* and
  // everything else stay public.
  const isGatedPath = (path: string) =>
    path === '/loops' || path.startsWith('/loops/') ||
    path === '/sessions' || path.startsWith('/sessions/') ||
    path === '/channels' || path.startsWith('/channels/') ||
    path === '/turns' || path.startsWith('/turns/')

  const httpServer = http.createServer((req, res) => {
    const url = req.url ?? ''
    const method = req.method ?? 'GET'

    // ---- CORS: permissive so a browser frontend on another origin can call the API ----
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS')
    res.setHeader('access-control-allow-headers', 'content-type,authorization')
    if (method === 'OPTIONS') { res.writeHead(204).end(); return } // preflight

    // ---- auth gate: when configured, /loops + /sessions require a valid Bearer ----
    // The resolved userId is threaded into dispatch so the gated routes scope by owner.
    if (cfg.auth && isGatedPath(url.split('?')[0]!)) {
      void resolveUserOr401(req, res).then((userId) => { if (userId) dispatch(userId) })
      return
    }
    dispatch()

    function dispatch(userId?: string) {
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

    // ---- sessions: read/write the chat layer so the frontend can drive it ----
    if (method === 'POST' && url === '/sessions') {
      if (!cfg.sessionStore) { res.writeHead(500).end('no session store'); return }
      void readBody(req).then(async (body) => {
        const { projectId, title } = JSON.parse(body || '{}') as { projectId?: string; title?: string }
        const opts = {
          ...(title !== undefined ? { title } : {}),
          ...(userId !== undefined ? { ownerId: userId } : {}),
        }
        const session = await cfg.sessionStore!.createSession(projectId, Object.keys(opts).length ? opts : undefined)
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(session))
      })
      return
    }

    if (method === 'GET' && url.split('?')[0] === '/sessions') {
      if (!cfg.sessionStore) { res.writeHead(500).end('no session store'); return }
      const projectId = new URL(url, 'http://x').searchParams.get('projectId') ?? undefined
      void cfg.sessionStore.listSessions(projectId, userId !== undefined ? { ownerId: userId } : undefined).then((sessions) => {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(sessions))
      })
      return
    }

    const sessMessages = /^\/sessions\/([^/]+)\/messages$/.exec(url)
    if (method === 'POST' && sessMessages) {
      const sessionId = sessMessages[1]!
      if (!cfg.sessionStore) { res.writeHead(500).end('no session store'); return }
      void readBody(req).then(async (body) => {
        const { sender, text } = JSON.parse(body || '{}') as { sender?: 'agent' | 'user'; text?: string }
        const message = await cfg.sessionStore!.appendMessage(sessionId, { sender: sender ?? 'user', text: text ?? '' })
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message))
      })
      return
    }

    if (method === 'GET' && sessMessages) {
      const sessionId = sessMessages[1]!
      if (!cfg.sessionStore) { res.writeHead(500).end('no session store'); return }
      void cfg.sessionStore.getMessages(sessionId).then((messages) => {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(messages))
      })
      return
    }

    // ---- C4: chat (standalone-chat wire contract §1-§3) ----
    // A channel === a session (channel_id === sessionId).

    // POST /channels/:id/messages: persist the user Message (200) THEN fire
    // respondToMessage fire-and-forget (trace + reply stream over the channel WS).
    const chMessages = /^\/channels\/([^/]+)\/messages$/.exec(url.split('?')[0]!)
    if (method === 'POST' && chMessages) {
      const channelId = chMessages[1]!
      if (!chatEnabled) { res.writeHead(500).end('chat not configured'); return }
      void readBody(req).then(async (body) => {
        const { type, content, reply_to } = JSON.parse(body || '{}') as {
          type?: string; content?: { text?: string }; reply_to?: string
        }
        const userMessage = await cfg.sessionStore!.appendMessage(channelId, {
          sender_type: 'user',
          type: type ?? 'text',
          content: { text: content?.text ?? '' },
          ...(reply_to !== undefined ? { reply_to } : {}),
        })
        // Mirror the user message to channel subscribers so other tabs see it too.
        emitForChannel(channelId)('new_message', { channel_id: channelId, message: userMessage })
        // Return the persisted user message immediately; the agent turn streams over WS.
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(userMessage))
        // Fire-and-forget the agent turn; failures surface as turn:update(failed) over WS.
        void respondToMessage(
          {
            sessionStore: cfg.sessionStore!,
            turnStore: cfg.turnStore!,
            traceStore: cfg.traceStore!,
            streamExecutor: cfg.streamExecutor!,
            emit: emitForChannel(channelId),
          },
          { channelId, ...(userId !== undefined ? { ownerId: userId } : {}), userMessage },
        ).catch(() => {})
      })
      return
    }

    // GET /channels/:id/messages?before_seq&limit → Message[] (paginates by seq).
    if (method === 'GET' && chMessages) {
      const channelId = chMessages[1]!
      if (!chatEnabled) { res.writeHead(500).end('chat not configured'); return }
      const params = new URL(url, 'http://x').searchParams
      const beforeSeq = params.get('before_seq')
      const limitRaw = params.get('limit')
      const before = beforeSeq !== null ? Number(beforeSeq) : undefined
      const limit = limitRaw !== null ? Number(limitRaw) : undefined
      void cfg.sessionStore!.getMessages(channelId).then((all) => {
        // Chronological (ascending seq). Window = messages with seq < before_seq,
        // then take the most-recent `limit` of that window (still ascending).
        let rows = before !== undefined ? all.filter((m) => m.seq < before) : all
        if (limit !== undefined && rows.length > limit) rows = rows.slice(rows.length - limit)
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(rows))
      })
      return
    }

    // GET /channels/:id/turns?limit → Turn[] (batch-hydrate trace handles on open).
    const chTurns = /^\/channels\/([^/]+)\/turns$/.exec(url.split('?')[0]!)
    if (method === 'GET' && chTurns) {
      const channelId = chTurns[1]!
      if (!chatEnabled) { res.writeHead(500).end('chat not configured'); return }
      const limitRaw = new URL(url, 'http://x').searchParams.get('limit')
      const limit = limitRaw !== null ? Number(limitRaw) : undefined
      void cfg.turnStore!.listByChannel(channelId, userId !== undefined ? { ownerId: userId } : undefined).then((turns) => {
        const rows = limit !== undefined && turns.length > limit ? turns.slice(turns.length - limit) : turns
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(rows))
      })
      return
    }

    // GET /turns/:id/events?after_seq → { turn_id, events: TraceEvent[] }.
    const turnEvents = /^\/turns\/([^/]+)\/events$/.exec(url.split('?')[0]!)
    if (method === 'GET' && turnEvents) {
      const turnId = turnEvents[1]!
      if (!chatEnabled) { res.writeHead(500).end('chat not configured'); return }
      const afterRaw = new URL(url, 'http://x').searchParams.get('after_seq')
      const afterSeq = afterRaw !== null ? Number(afterRaw) : undefined
      void cfg.traceStore!.list(turnId, afterSeq).then((events) => {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ turn_id: turnId, events }))
      })
      return
    }

    // GET /turns/:id → Turn (metadata).
    const turnGet = /^\/turns\/([^/]+)$/.exec(url.split('?')[0]!)
    if (method === 'GET' && turnGet) {
      const turnId = turnGet[1]!
      if (!chatEnabled) { res.writeHead(500).end('chat not configured'); return }
      void cfg.turnStore!.get(turnId).then((turn) => {
        if (!turn) { res.writeHead(404).end('unknown turn'); return }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(turn))
      })
      return
    }

    // ---- P2: loop CRUD ----
    if (method === 'POST' && url === '/loops') {
      if (!cfg.store) { res.writeHead(500).end('no loop store'); return }
      void readBody(req).then(async (body) => {
        const spec = JSON.parse(body || '{}') as LoopSpec
        if (!spec.id || !spec.flow) { res.writeHead(400).end('invalid loop spec'); return }
        // When auth is configured, stamp the loop with the authed owner so list scoping works.
        const owned = userId !== undefined ? { ...spec, ownerId: userId } : spec
        await cfg.store!.upsert(owned)
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: owned.id }))
      })
      return
    }

    if (method === 'GET' && url === '/loops') {
      if (!cfg.store) { res.writeHead(500).end('no loop store'); return }
      void cfg.store.list(userId).then((loops) => {
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

    // ---- auth: GitHub OAuth bearer (only mounted when configured) ----
    if (cfg.auth) {
      const { github, userStore, tokenStore, sessionSecret, appBaseUrl } = cfg.auth
      const path = url.split('?')[0]

      if (method === 'GET' && path === '/auth/login') {
        res.writeHead(302, { location: github.authorizeUrl(signState(sessionSecret)) }).end()
        return
      }

      if (method === 'GET' && path === '/auth/callback') {
        const params = new URL(url, 'http://x').searchParams
        const code = params.get('code') ?? ''
        const state = params.get('state') ?? ''
        if (!verifyState(state, sessionSecret)) {
          res.writeHead(302, { location: `${appBaseUrl}#auth_error=bad_state` }).end()
          return
        }
        // Wrap the exchange so a failing GitHub round-trip lands the user on an
        // error hash, never a 500 dead end.
        void (async () => {
          try {
            const accessToken = await github.exchangeCode(code)
            const gh = await github.fetchUser(accessToken)
            const user = await userStore.upsertByGithub(gh)
            const token = await tokenStore.issue(user.id)
            res.writeHead(302, { location: `${appBaseUrl}#token=${token}` }).end()
          } catch (err) {
            const reason = encodeURIComponent(err instanceof Error ? err.message : 'exchange_failed')
            res.writeHead(302, { location: `${appBaseUrl}#auth_error=${reason}` }).end()
          }
        })()
        return
      }

      if (method === 'GET' && path === '/auth/me') {
        const header = req.headers.authorization ?? ''
        const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
        void (async () => {
          const userId = token ? await tokenStore.resolve(token) : undefined
          const user = userId ? await userStore.getById(userId) : undefined
          if (!user) { res.writeHead(401).end(); return }
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(user))
        })()
        return
      }
    }

    res.writeHead(404).end()
    }
  })

  const wss = new WebSocketServer({ server: httpServer })
  wss.on('connection', (ws, req) => {
    const reqUrl = req.url ?? ''

    // Chat: subscribe to a channel's live envelopes. `?trace=1` (subscribe_trace)
    // opts the connection into the trace:* stream too. Envelope wire shape is set
    // per-type by the sink below (nested for the v2 family, flat for new_message).
    const ch = /^\/channels\/([^/]+)\/events/.exec(reqUrl)
    if (ch) {
      const channelId = ch[1]
      if (!channelId) { ws.close(); return }
      const trace = new URL(reqUrl, 'http://x').searchParams.get('trace') === '1'
      // Wire shape per the frontend's useWebSocket dispatcher: the trace v2
      // family (turn:created/turn:update/trace:event/trace:batch/msg:chunk) is a
      // NESTED envelope `{ type, payload }` (handleTraceEnvelope reads data.payload),
      // while new_message is FLAT `{ type, channel_id, message }` (it reads the
      // fields at top level). Nest the v2 family; spread everything else flat.
      const sink = {
        send: (type: string, payload: unknown) =>
          ws.send(JSON.stringify(
            V2_ENVELOPE_TYPES.has(type)
              ? { type, payload }
              : { type, ...(payload as Record<string, unknown>) },
          )),
        trace,
      }
      ;(chatSubs.get(channelId) ?? chatSubs.set(channelId, new Set()).get(channelId)!).add(sink)
      ws.on('close', () => chatSubs.get(channelId)?.delete(sink))
      return
    }

    const m = /\/runs\/([^/]+)\/events/.exec(reqUrl)
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
