/**
 * Daemon process (spec §4). The prod engine never runs `claude`; this daemon
 * runs on the user's machine (where `claude` is authed), connects to the engine
 * over WS (`ENGINE_WS_URL` = ws://…/daemon/ws?token=$DAEMON_TOKEN), sends
 * `daemon:hello`, and on each `agent:run` runs `claude -p stream-json` LOCALLY —
 * reusing the SHARED `mapStreamJsonLine` parser from streamExecutor — streaming
 * `turn:start` / `trace:batch` / `turn:end` back. Reconnects with backoff if the
 * socket drops. Slim subset: single daemon, single implicit agent.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import WebSocket from 'ws'
import { mapStreamJsonLine } from '../chat/streamExecutor'
import type { MappedEvent } from '../chat/streamExecutor'
import { PROTOCOL_VERSION } from './protocol'
import type {
  AgentRunMessage,
  DaemonToEngineMessage,
  EngineToDaemonMessage,
} from './protocol'

/**
 * One turn-scoped event from `runClaudeTurn`, WITHOUT the turnId — the daemon
 * stamps the active turnId before forwarding to the engine. Mirrors the
 * daemon→engine turn envelopes (spec §2) minus correlation.
 */
export type TurnEvent =
  | { type: 'turn:start' }
  | { type: 'trace:batch'; events: MappedEvent[] }
  | { type: 'turn:end'; status: 'completed' | 'failed'; finalText: string; usage?: unknown; error?: string }

export interface TurnResult {
  status: 'completed' | 'failed'
  finalText: string
  usage?: unknown
  error?: string
}

export interface RunClaudeTurnOpts {
  onEvent: (e: TurnEvent) => void
  spawn?: typeof nodeSpawn
  bin?: string
  model?: string
}

/**
 * Run one turn locally: spawn `claude -p --output-format stream-json --verbose`
 * (+ `--model` when set), feed the prompt on stdin, parse stdout NDJSON with the
 * SHARED `mapStreamJsonLine`, and emit `turn:start` (once), a `trace:batch` per
 * mapped event, and `turn:end` on exit. `spawn` is injectable so this is unit-
 * testable with a fake child — no real `claude` required.
 */
export function runClaudeTurn(prompt: string, opts: RunClaudeTurnOpts): Promise<TurnResult> {
  const spawn = opts.spawn ?? nodeSpawn
  const bin = opts.bin ?? 'claude'
  const { onEvent } = opts
  return new Promise((resolve) => {
    const argv = ['-p', '--output-format', 'stream-json', '--verbose']
    if (opts.model) argv.push('--model', opts.model)
    const child = spawn(bin, argv)
    onEvent({ type: 'turn:start' })

    let buf = ''
    let stderr = ''
    let finalText = ''
    let usage: unknown
    let isError = false
    let errorText: string | undefined

    const handleLine = (line: string) => {
      const mapped = mapStreamJsonLine(line)
      if (mapped.length === 0) return
      for (const m of mapped) {
        if (m.kind === 'text') {
          const c = (m.payload as { content?: unknown }).content
          if (typeof c === 'string') finalText += c
        } else if (m.kind === 'result') {
          usage = (m.payload as { usage?: unknown }).usage
        } else if (m.kind === 'error') {
          isError = true
          const e = (m.payload as { error?: unknown }).error
          if (typeof e === 'string') errorText = e
        }
        // One trace:batch per mapped event keeps ordering 1:1 with the stream.
        onEvent({ type: 'trace:batch', events: [m] })
      }
    }

    child.stdout?.on('data', (b: Buffer) => {
      buf += b.toString()
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        handleLine(line)
      }
    })
    child.stderr?.on('data', (b: Buffer) => { stderr += b.toString() })

    const finish = (code: number | null, spawnErr?: Error) => {
      if (buf.trim()) handleLine(buf)
      if (spawnErr) {
        isError = true
        errorText = errorText ?? spawnErr.message
      } else if (code !== 0 && code !== null) {
        isError = true
        errorText = errorText ?? (stderr.trim() || `claude exited ${code}`)
      }
      const status: 'completed' | 'failed' = isError ? 'failed' : 'completed'
      const end: TurnEvent = {
        type: 'turn:end',
        status,
        finalText,
        ...(usage !== undefined ? { usage } : {}),
        ...(errorText !== undefined ? { error: errorText } : {}),
      }
      onEvent(end)
      resolve({ status, finalText, usage, error: errorText })
    }

    child.on('error', (err: Error) => finish(null, err))
    child.on('close', (code: number) => finish(code))

    // Feed the prompt and close stdin so claude runs the one-shot.
    child.stdin?.write(prompt)
    child.stdin?.end()
  })
}

export interface StartDaemonOpts {
  url: string
  /** Injectable for tests; defaults to the real local claude spawn loop. */
  runTurn?: (prompt: string, opts: RunClaudeTurnOpts) => Promise<TurnResult>
  spawn?: typeof nodeSpawn
  bin?: string
  /** Base reconnect backoff in ms (doubles up to a cap). */
  backoffMs?: number
  onState?: (state: 'connecting' | 'open' | 'closed') => void
}

export interface DaemonHandle {
  /** Stop reconnecting and close the current socket. */
  stop(): void
  /** Test hook: force-close the current socket to exercise reconnect. */
  dropForTest(): void
}

/**
 * Connect to the engine and serve turns. On open: send `daemon:hello`. On
 * `agent:run`: run the turn (default: local claude) and stream the turn events
 * back stamped with the turnId. On close: reconnect with exponential backoff
 * (capped) until `stop()`.
 */
export function startDaemon(opts: StartDaemonOpts): DaemonHandle {
  const runTurn = opts.runTurn ?? ((prompt, o) => runClaudeTurn(prompt, o))
  const baseBackoff = opts.backoffMs ?? 1000
  const maxBackoff = 30_000
  const onState = opts.onState ?? (() => {})

  let ws: WebSocket | undefined
  let stopped = false
  let backoff = baseBackoff
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined

  const send = (msg: DaemonToEngineMessage) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  const handleRun = (run: AgentRunMessage) => {
    const { turnId } = run
    void runTurn(run.prompt, {
      ...(run.model !== undefined ? { model: run.model } : {}),
      ...(opts.spawn !== undefined ? { spawn: opts.spawn } : {}),
      ...(opts.bin !== undefined ? { bin: opts.bin } : {}),
      // Stamp the turnId onto each turn-scoped event before forwarding.
      onEvent: (e) => {
        if (e.type === 'turn:start') send({ type: 'turn:start', turnId })
        else if (e.type === 'trace:batch') send({ type: 'trace:batch', turnId, events: e.events })
        else send({
          type: 'turn:end',
          turnId,
          status: e.status,
          finalText: e.finalText,
          ...(e.usage !== undefined ? { usage: e.usage } : {}),
          ...(e.error !== undefined ? { error: e.error } : {}),
        })
      },
    })
  }

  const connect = () => {
    if (stopped) return
    onState('connecting')
    const sock = new WebSocket(opts.url)
    ws = sock
    sock.on('open', () => {
      backoff = baseBackoff // reset on a successful connect
      onState('open')
      send({ type: 'daemon:hello', protocol: PROTOCOL_VERSION })
    })
    sock.on('message', (data) => {
      let msg: EngineToDaemonMessage
      try {
        msg = JSON.parse((data as Buffer).toString()) as EngineToDaemonMessage
      } catch {
        return
      }
      if (msg && msg.type === 'agent:run') handleRun(msg)
      // agent:cancel is accepted on the wire but not yet acted on (slim v1).
    })
    sock.on('error', () => {}) // a failed connect surfaces as error → close fires
    sock.on('close', () => {
      onState('closed')
      if (stopped) return
      reconnectTimer = setTimeout(connect, backoff)
      backoff = Math.min(backoff * 2, maxBackoff)
    })
  }

  connect()

  return {
    stop() {
      stopped = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      ws?.close()
    },
    dropForTest() {
      ws?.close()
    },
  }
}

// Entry: `npm run daemon`. Reads ENGINE_WS_URL from env and starts the link.
function isMainModule(): boolean {
  const entry = process.argv[1] ?? ''
  return import.meta.url === `file://${entry}` || import.meta.url.endsWith(entry)
}

if (isMainModule()) {
  const url = process.env.ENGINE_WS_URL
  if (!url) {
    console.error('ENGINE_WS_URL is required (e.g. ws://localhost:8787/daemon/ws?token=$DAEMON_TOKEN)')
    process.exit(1)
  }
  const handle = startDaemon({
    url,
    onState: (s) => console.log(`[daemon] ${s} → ${url}`),
  })
  process.on('SIGINT', () => { handle.stop(); process.exit(0) })
  process.on('SIGTERM', () => { handle.stop(); process.exit(0) })
}
