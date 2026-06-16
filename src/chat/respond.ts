import { randomUUID } from 'node:crypto'
import type { SessionStore, Message } from '../session/types'
import type { TurnStore, TraceStore, Turn, TurnUsage } from './types'
import type { StreamExecutor, MappedEvent } from './streamExecutor'

/**
 * respondToMessage — the chat-respond orchestration (spec §2).
 *
 * Given a trigger user Message (already persisted), drives one agent reply:
 *   create Turn(queued)  → emit turn:created
 *   Turn → in_progress   → emit turn:update(started_at)
 *   run the streamExecutor over the channel history prompt, and per mapped event
 *     persist a TraceEvent + emit trace:batch / trace:event;
 *     for text / text_delta also emit msg:chunk building the agent message
 *   on success: persist the final agent Message(turn_id) → emit new_message +
 *     msg:chunk(is_final) → Turn completed(usage) → emit turn:update
 *   on failure (isError): Turn failed(error) → emit turn:update; no agent Message.
 *
 * `emit` is an injected sink (the server wires it to WS). Envelope shapes follow
 * spec §1 exactly. Stores are scoped by ownerId like loops/sessions.
 */

/** Server→client envelope sink. The server wires this to WS broadcast. */
export type Emit = (type: string, payload: unknown) => void

export interface RespondDeps {
  sessionStore: SessionStore
  turnStore: TurnStore
  traceStore: TraceStore
  streamExecutor: StreamExecutor
  emit: Emit
  /** Injectable clock for deterministic tests. */
  now?: () => number
  /** Single implicit agent id. Defaults to 'claude'. */
  agentId?: string
  /** Number of recent messages to feed as history. Defaults to 30. */
  historyLimit?: number
  /** Model passed to the executor, if any. */
  model?: string
}

export interface RespondArgs {
  channelId: string
  ownerId?: string
  /** The trigger user Message (assumed already persisted). */
  userMessage: Message
}

export interface RespondResult {
  turn: Turn
  /** The persisted agent Message, when the run succeeded. */
  message?: Message
}

/** Slim recent-N history → a prompt string (spec §2: no Project.md/rules.md). */
function assembleHistory(messages: Message[], limit: number): string {
  const recent = messages.slice(Math.max(0, messages.length - limit))
  return recent
    .map((m) => `${m.sender_type === 'user' ? 'User' : m.sender_type === 'agent' ? 'Assistant' : 'System'}: ${m.content.text}`)
    .join('\n')
}

export async function respondToMessage(deps: RespondDeps, args: RespondArgs): Promise<RespondResult> {
  const { sessionStore, turnStore, traceStore, streamExecutor, emit } = deps
  const now = deps.now ?? Date.now
  const agentId = deps.agentId ?? 'claude'
  const historyLimit = deps.historyLimit ?? 30
  const { channelId, ownerId, userMessage } = args

  // 1. Create the Turn (queued) + broadcast turn:created.
  const turn = await turnStore.create({
    agent_id: agentId,
    channel_id: channelId,
    trigger_msg_id: userMessage.id,
    trigger_preview: userMessage.content.text.slice(0, 120),
    status: 'queued',
    ...(ownerId !== undefined ? { ownerId } : {}),
  })
  emit('turn:created', {
    turn_id: turn.turn_id,
    agent_id: turn.agent_id,
    channel_id: turn.channel_id,
    trigger_msg_id: turn.trigger_msg_id,
    trigger_preview: turn.trigger_preview,
    status: turn.status,
    created_at: turn.created_at,
  })

  // 2. Turn → in_progress + broadcast turn:update(started_at).
  const startedAt = now()
  await turnStore.setStatus(turn.turn_id, { status: 'in_progress', started_at: startedAt })
  emit('turn:update', { turn_id: turn.turn_id, status: 'in_progress', started_at: startedAt })

  // 3. Assemble the channel history → prompt.
  const history = await sessionStore.getMessages(channelId)
  const prompt = assembleHistory(history, historyLimit)

  // The streaming agent message id is stable across all chunks for this turn.
  const agentMessageId = randomUUID()

  // 4. Run the executor; per mapped event → persist a TraceEvent + broadcast,
  //    and for text/text_delta also emit msg:chunk building the agent message.
  //    onEvent may be called synchronously (fakes) or async (real spawn); persist
  //    is async (RMW JSON), so serialize the per-event work onto one chain and
  //    drain it before finalising — keeps trace/chunk emits strictly before
  //    new_message and avoids interleaved seq writes.
  let chain: Promise<void> = Promise.resolve()
  const handleEvent = async (ev: MappedEvent) => {
    const stored = await traceStore.append(turn.turn_id, {
      kind: ev.kind as never,
      ...(ev.severity !== undefined ? { severity: ev.severity as never } : {}),
      payload: (ev.payload ?? {}) as Record<string, unknown>,
    })
    emit('trace:event', stored)
    emit('trace:batch', { turn_id: turn.turn_id, events: [stored] })

    if (ev.kind === 'text' || ev.kind === 'text_delta') {
      const p = (ev.payload ?? {}) as { content?: unknown; chunk?: unknown }
      const chunk = typeof p.chunk === 'string' ? p.chunk : typeof p.content === 'string' ? p.content : ''
      emit('msg:chunk', {
        message_id: agentMessageId,
        channel_id: channelId,
        agent_id: agentId,
        chunk,
        is_final: false,
        streaming: true,
      })
    }
  }
  const onEvent = (ev: MappedEvent) => {
    chain = chain.then(() => handleEvent(ev))
  }

  let result
  try {
    result = await streamExecutor.run({ prompt, ...(deps.model !== undefined ? { model: deps.model } : {}) }, onEvent)
    await chain // drain any still-pending per-event work
  } catch (err) {
    await chain.catch(() => {})
    return finishFailed(err instanceof Error ? err.message : String(err), 'spawn')
  }

  // 5a. Failure path: isError → Turn failed(error) + turn:update. No agent Message.
  if (result.isError) {
    return finishFailed(result.errorText ?? 'agent run failed', 'agent')
  }

  // 5b. Success path: persist the final agent Message(turn_id), broadcast
  //     new_message + msg:chunk(is_final), then Turn completed(usage).
  const finalText = result.finalText ?? ''
  // Persist with the streaming bubble id so chunks + the final message share
  // one message_id (the frontend reconciles the bubble by message_id).
  const message = await sessionStore.appendMessage(channelId, {
    id: agentMessageId,
    sender_id: agentId,
    sender_type: 'agent',
    type: 'text',
    content: { text: finalText },
    turn_id: turn.turn_id,
  })
  emit('new_message', { channel_id: channelId, message })
  emit('msg:chunk', {
    message_id: agentMessageId,
    channel_id: channelId,
    agent_id: agentId,
    chunk: finalText,
    is_final: true,
    streaming: false,
  })

  const completedAt = now()
  const usage = (result.usage ?? undefined) as TurnUsage | undefined
  const completed = await turnStore.setStatus(turn.turn_id, {
    status: 'completed',
    completed_at: completedAt,
    last_event_at: completedAt,
    ...(usage !== undefined ? { usage } : {}),
  })
  emit('turn:update', {
    turn_id: turn.turn_id,
    status: 'completed',
    completed_at: completedAt,
    ...(usage !== undefined ? { usage } : {}),
  })

  return { turn: completed, message }

  async function finishFailed(errorMessage: string, errorCode: string): Promise<RespondResult> {
    const completedAt = now()
    const failed = await turnStore.setStatus(turn.turn_id, {
      status: 'failed',
      completed_at: completedAt,
      error_code: errorCode,
      error_message: errorMessage,
    })
    emit('turn:update', {
      turn_id: turn.turn_id,
      status: 'failed',
      completed_at: completedAt,
      error_code: errorCode,
      error_message: errorMessage,
    })
    return { turn: failed }
  }
}
