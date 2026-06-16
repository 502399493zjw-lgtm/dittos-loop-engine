import { spawn as nodeSpawn } from 'node:child_process'

/**
 * One mapped trace event, as handed to `onEvent`. kind/payload follow the
 * spec §3 stream-json→TraceEvent table verbatim — the chat-respond flow
 * stamps turn_id/seq/created_at on top before persisting + broadcasting.
 */
export interface MappedEvent {
  kind: string
  payload: unknown
  severity?: string
}

export interface StreamRequest {
  prompt: string
  model?: string
  /**
   * The user whose linked local daemon should run this turn (daemon-mode owner
   * routing, spec §1). The daemonExecutor dispatches to this user's conn; unset
   * in the in-process claude path (ignored there).
   */
  ownerId?: string
}

export interface StreamResult {
  usage?: unknown
  finalText: string
  isError?: boolean
  errorText?: string
}

export interface StreamExecutor {
  run(req: StreamRequest, onEvent: (e: MappedEvent) => void): Promise<StreamResult>
}

// ----------------------- stream-json shapes -----------------------
// Minimal structural typing of the `claude -p --output-format stream-json
// --verbose` NDJSON. We only read the fields the §3 mapping needs.

interface ContentBlock {
  type?: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
}
interface StreamMessage {
  id?: string
  content?: ContentBlock[]
}
interface StreamEvent {
  type?: string
  subtype?: string
  message?: StreamMessage
  result?: string
  is_error?: boolean
  usage?: unknown
  error?: string
  code?: unknown
}

/**
 * Pure parse + map of a single NDJSON line → 0..n MappedEvents per the
 * spec §3 table. Blank lines, unparseable lines, and ignored event types
 * (system/init, user-text echoes) yield []. Exported for direct unit
 * testing with fixture lines — no spawn required.
 *
 * | stream-json                       | kind            | payload                              |
 * |-----------------------------------|-----------------|-------------------------------------|
 * | assistant block `thinking`        | thinking        | { content }                         |
 * | assistant block `tool_use`        | tool_use_start  | { tool_use_id, tool_name, input }   |
 * | user block `tool_result`          | tool_use_result | { tool_use_id, output }             |
 * | assistant block `text`            | text            | { content, message_id }             |
 * | `result` (is_error=false)         | result          | { usage }                           |
 * | `result` (is_error=true)          | error           | { error, code }                     |
 */
export function mapStreamJsonLine(line: string): MappedEvent[] {
  const trimmed = line.trim()
  if (!trimmed) return []
  let ev: StreamEvent
  try {
    ev = JSON.parse(trimmed) as StreamEvent
  } catch {
    return []
  }
  const out: MappedEvent[] = []
  if (ev.type === 'assistant' && ev.message) {
    const msgId = ev.message.id
    for (const block of ev.message.content ?? []) {
      if (block.type === 'thinking') {
        out.push({ kind: 'thinking', payload: { content: block.thinking ?? '' }, severity: 'info' })
      } else if (block.type === 'text') {
        out.push({ kind: 'text', payload: { content: block.text ?? '', message_id: msgId }, severity: 'info' })
      } else if (block.type === 'tool_use') {
        out.push({
          kind: 'tool_use_start',
          payload: { tool_use_id: block.id, tool_name: block.name, input: block.input },
          severity: 'info',
        })
      }
    }
  } else if (ev.type === 'user' && ev.message) {
    for (const block of ev.message.content ?? []) {
      if (block.type === 'tool_result') {
        out.push({
          kind: 'tool_use_result',
          payload: { tool_use_id: block.tool_use_id, output: block.content },
          severity: 'info',
        })
      }
    }
  } else if (ev.type === 'result') {
    if (ev.is_error) {
      out.push({ kind: 'error', payload: { error: ev.result ?? ev.error ?? '', code: ev.code }, severity: 'error' })
    } else {
      out.push({ kind: 'result', payload: { usage: ev.usage }, severity: 'info' })
    }
  }
  // system/init and anything else: no mapped events.
  return out
}

/**
 * Real executor: spawns `claude -p --output-format stream-json --verbose`
 * (plus `--model` when set), parses stdout NDJSON line-by-line, maps each
 * line via mapStreamJsonLine and pushes to onEvent. Assembles finalText
 * from assistant `text` blocks, captures usage from the `result` event,
 * and surfaces isError on nonzero exit / `result.is_error` / stderr.
 */
export function claudeStreamExecutor(opts: { spawn?: typeof nodeSpawn; bin?: string } = {}): StreamExecutor {
  const spawn = opts.spawn ?? nodeSpawn
  const bin = opts.bin ?? 'claude'
  return {
    run(req: StreamRequest, onEvent: (e: MappedEvent) => void): Promise<StreamResult> {
      return new Promise((resolve, reject) => {
        const argv = ['-p', '--output-format', 'stream-json', '--verbose']
        if (req.model) argv.push('--model', req.model)
        argv.push(req.prompt)
        const child = spawn(bin, argv)
        let buf = ''
        let stderr = ''
        let finalText = ''
        let usage: unknown
        let isError = false
        let errorText: string | undefined

        const handleLine = (line: string) => {
          for (const mapped of mapStreamJsonLine(line)) {
            if (mapped.kind === 'text') {
              const c = (mapped.payload as { content?: unknown }).content
              if (typeof c === 'string') finalText += c
            } else if (mapped.kind === 'result') {
              usage = (mapped.payload as { usage?: unknown }).usage
            } else if (mapped.kind === 'error') {
              isError = true
              const e = (mapped.payload as { error?: unknown }).error
              if (typeof e === 'string') errorText = e
            }
            onEvent(mapped)
          }
        }

        child.stdout.on('data', (b: Buffer) => {
          buf += b.toString()
          let nl: number
          while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl)
            buf = buf.slice(nl + 1)
            handleLine(line)
          }
        })
        child.stderr.on('data', (b: Buffer) => { stderr += b.toString() })
        child.on('error', (err: Error) => reject(err))
        child.on('close', (code: number) => {
          if (buf.trim()) handleLine(buf)
          if (code !== 0) {
            isError = true
            errorText = errorText ?? (stderr.trim() || `claude exited ${code}`)
          }
          resolve({ usage, finalText, isError: isError || undefined, errorText })
        })
      })
    },
  }
}

export interface FakeStreamExecutor extends StreamExecutor {
  calls: StreamRequest[]
}

/**
 * Scripted executor for unit-testing the chat-respond flow with no spawn:
 * replays `events` to onEvent in order, then resolves the configured
 * finalText/usage/isError/errorText. Records every run() request in `calls`.
 */
export function fakeStreamExecutor(opts: {
  events?: MappedEvent[]
  finalText?: string
  usage?: unknown
  isError?: boolean
  errorText?: string
}): FakeStreamExecutor {
  const events = opts.events ?? []
  const calls: StreamRequest[] = []
  return {
    calls,
    async run(req: StreamRequest, onEvent: (e: MappedEvent) => void): Promise<StreamResult> {
      calls.push(req)
      for (const e of events) onEvent(e)
      return {
        usage: opts.usage,
        finalText: opts.finalText ?? '',
        isError: opts.isError,
        errorText: opts.errorText,
      }
    },
  }
}
