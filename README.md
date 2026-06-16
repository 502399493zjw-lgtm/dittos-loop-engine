# dittos-loop-engine

**The Loop Flow engine behind [loop.dittos.chat](https://loop.dittos.chat)** — a command-imperative agent flow engine with live phase/agent event streaming and a self-managing loop runtime.

---

## Why

Most agent frameworks ask you to declare a graph. Dittos Loop Flow does the opposite: you write an agent as an **imperative flow** — plain `async` code that calls `parallel`, `pipeline`, `phase`, and `agent` primitives (mirroring the shape of Claude Code's Workflow). The control flow *is* the program; the engine just instruments it, emitting a live event per phase and per agent node as the flow runs.

On top of single runs sits a **loop runtime** that turns a flow into a self-managing, recurring agent. The runtime:

- **ratchets a cursor on success** — the flow calls `api.commit({ cursor })`; the new cursor is only persisted if the run completes, so a crash mid-run never advances past unfinished work,
- **pauses after N consecutive failures** (default 3) so a broken loop stops burning attempts instead of spinning,
- **caps per-run budget** in USD — exceeding the cap fails the run and pauses the loop with reason `budget`,
- **keeps a per-loop memory file** (`<loopId>.md`) the flow can read and append to across iterations.

A run is one execution of a flow. A loop is a stored spec + state that the scheduler ticks on an interval, applying that contract every time.

---

## Quickstart

```bash
npm i           # install deps (ws + dev toolchain)
npm test        # vitest run — the full P1+P2 suite

npm run dev               # run the demo flow once with the FAKE executor (no tokens)
RUN_REAL=1 npm run dev    # same demo flow against the real `claude -p`

npm run serve             # boot the HTTP/WS backend on :8787 (fake executor)
RUN_REAL=1 npm run serve  # backend on :8787 driving the real `claude -p`
```

`npm run dev` runs a one-step demo flow and prints the event stream as NDJSON to stdout. `npm run serve` boots the full backend (`POST /runs`, the `/loops` CRUD + trigger/resume, the WS event stream) and seeds a `demo-loop` so there's something to talk to. Override the port with `PORT=...`.

---

## Primitives

A flow is `(api: FlowApi) => Promise<unknown>`. The `FlowApi` it receives:

```ts
interface FlowApi {
  agent(prompt: string, opts?: AgentOpts): Promise<string | Record<string, unknown>>
  parallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>>
  pipeline(items: unknown[], ...stages: Array<(prev: unknown, item: unknown, i: number) => Promise<unknown>>): Promise<unknown[]>
  phase(title: string): void
  log(message: string): void
  /** Record the new cursor; only persisted if the run completes. */
  commit(patch: { cursor?: unknown }): void
  /** Per-loop memory.md surface; falls back to an in-process noop when no memory is injected. */
  memory: Memory          // { read(): string; append(line: string): void }
  args: unknown
}

interface AgentOpts {
  agent?: string                       // a specific agent; omitted → the run's default agent
  schema?: Record<string, unknown>     // when set, the result text is JSON.parsed + returned as an object
  model?: string
  label?: string                       // work-card label; defaults to a slug of the prompt
  phase?: string                       // force this node under a named phase instead of the active one
}
```

A real flow using the primitives:

```ts
import type { Flow } from './src/types'

const triage: Flow = async (api) => {
  api.phase('gather')
  api.log('reading the queue')

  const items = ['ticket-1', 'ticket-2', 'ticket-3']

  // parallel(): run independent agent calls concurrently; a thrown thunk becomes null.
  const summaries = await api.parallel(
    items.map((id) => () => api.agent(`Summarize ${id} in one line.`, { label: `sum:${id}` })),
  )

  api.phase('classify')

  // pipeline(): map each item through ordered stages; prev is the previous stage's output.
  const labels = await api.pipeline(
    items,
    (_prev, item) => api.agent(`Classify ${item} as bug|feature|noise.`, {
      schema: { type: 'object', properties: { label: { type: 'string' } } },
    }),
    (prev) => api.agent(`Given ${JSON.stringify(prev)}, draft a one-line reply.`),
  )

  // memory persists across loop iterations; cursor only advances if the run completes.
  api.memory.append(`processed ${items.length} items`)
  api.commit({ cursor: items.at(-1) })

  return { summaries, labels }
}
```

`parallel` swallows a failed thunk into `null` (the rest still resolve); `pipeline` runs each item through its stages and yields `null` for any item whose stages throw. `phase(title)` closes the previous phase (`phase_done`) and opens a new one (`phase_started`), so every `agent` node afterward is attributed to it.

---

## Executors

An executor is the seam between the flow and an actual model. It implements one method:

```ts
interface Executor { run(req: ExecutorRequest): Promise<ExecutorResult> }
// ExecutorRequest: { agentId, prompt, model?, schema? }
// ExecutorResult:  { text, raw?, cost?, tokensIn?, tokensOut? }
```

- **`claudeCliExecutor()`** (`src/executor/claudeCli.ts`) spawns `claude -p --output-format json` (adding `--model` when set), reads the last JSON line of stdout, and returns `{ text: json.result, raw: json, cost: json.total_cost_usd }`. A non-zero exit or `is_error: true` rejects. It uses **your logged-in Claude subscription** — no API key plumbing, no separate billing.
- **`fakeExecutor({ replies })`** (`src/executor/fake.ts`) is the deterministic test/dev double. It records every call on `.calls`, returns scripted text keyed by `` `${agentId}:${prompt}` ``, falls back to `echo:<prompt>`, and can be scripted to throw.

---

## Event model

Every run emits a stream of `EngineEvent`s (from `src/types.ts`). Each carries `runId` and `ts`:

- `run_started` — `{ args }`
- `phase_started` — `{ phaseId, title }`
- `agent_started` — `{ nodeId, phaseId, agentId, label, prompt }`
- `agent_done` — `{ nodeId, status: 'ok' | 'failed', result?, error?, cost?, durationMs }`
- `phase_done` — `{ phaseId, status: 'ok' | 'failed' }`
- `log` — `{ message }`
- `budget_exceeded` — `{ spent, cap }`
- `run_done` — `{ status: 'running' | 'completed' | 'failed', summary?, result? }`

---

## HTTP / WS API

`createServer(cfg).listen(port)` serves the following. All responses carry permissive CORS headers (`access-control-allow-origin: *`); an `OPTIONS` request short-circuits as a `204` preflight.

### `POST /runs` — fire an ad-hoc run

Request body:

```json
{ "flow": "demo", "args": {} }
```

`flow` keys into the server's `flows` registry; unknown flow → `404`. Responds `202` immediately with the run id, then streams events over WS:

```json
{ "runId": "f1e2..." }
```

### `POST /loops` — create / upsert a loop

Body is a `LoopSpec`; `id` and `flow` are required (else `400`). Requires a configured loop store (else `500`).

```json
{ "id": "L1", "flow": "demo", "trigger": { "kind": "interval", "everyMs": 600000 }, "budgetUsd": 1.5, "maxConsecutiveFailures": 3 }
```

Response: `{ "id": "L1" }`. An upsert preserves the existing `state` of a known loop; a new loop starts at `{ cursor: null, consecutiveFailures: 0, paused: false }`.

### `GET /loops` — list loops with state

```json
[
  {
    "spec": { "id": "L1", "flow": "demo", "trigger": { "kind": "interval", "everyMs": 600000 } },
    "state": { "cursor": null, "consecutiveFailures": 0, "paused": false }
  }
]
```

### `POST /loops/:id/trigger` — run one tick now

Fires `runner.tick(id)` (fire-and-forget; events stream over WS) and resolves with the run id that tick produced. Unknown loop → `404`; no runner configured → `500`.

```json
{ "runId": "28aabe59-..." }
```

### `POST /loops/:id/resume` — clear a pause

Sets `{ paused: false, consecutiveFailures: 0, pausedReason: undefined }`. Unknown loop → `404`.

```json
{ "id": "L1" }
```

### `WS /runs/:id/events` — live event stream

Connect to `ws://<host>/runs/<runId>/events`. The server **replays the buffered events** for that run first (so a late joiner catches up), then forwards each new `EngineEvent` as JSON until the socket closes. Loop runs stream through the same per-run plumbing as ad-hoc `/runs`, keyed by the run id from `trigger`.

---

## Loop runtime

A loop is a persisted spec plus mutable state:

```ts
interface LoopSpec {
  id: string
  flow: string                                    // key into the server's flows registry
  trigger: { kind: 'interval'; everyMs: number }  // P2: interval only; cron later
  budgetUsd?: number                              // per-run cost cap; undefined = no cap
  maxConsecutiveFailures?: number                 // default 3
}

interface LoopState {
  cursor: unknown                                 // opaque; advanced by the flow via api.commit({cursor})
  consecutiveFailures: number
  paused: boolean
  pausedReason?: 'failures' | 'budget'
  lastRunAt?: number
}
```

**The `LoopRunner.tick(loopId)` contract:**

1. A **paused** loop is a no-op.
2. The runner loads the spec + state, builds a file-backed `memory` (`<memoryDir>/<loopId>.md`), and calls `runFlow` with `args: { cursor: state.cursor }` and `budgetUsd: spec.budgetUsd`. `lastRunAt` is recorded.
3. On **success**: `consecutiveFailures` resets to `0`, and if the flow committed a cursor it is persisted — the cursor only ratchets forward on a completed run.
4. On **failure**: `consecutiveFailures` increments (cursor unchanged). When the count reaches `maxConsecutiveFailures` (default `3`), the loop is **paused** with reason `failures` and a notification fires.
5. On a **budget blowout**: the runner sees the `budget_exceeded` event, attributes the failure to `budget`, and **pauses immediately** regardless of the failure count.

Budget accounting happens *after* an agent node succeeds — crossing the cap fails the run, not the node, so you always get the agent's output and a clean `budget_exceeded` + `run_done(failed)` pair.

**The scheduler** (`loopScheduler`) runs a single `setInterval(tickMs)`: it lists every loop and fires `runner.tick(id)` for each non-paused loop whose interval has elapsed (`now - (lastRunAt ?? 0) >= trigger.everyMs`). Ticks are fire-and-forget and per-loop errors are swallowed, so one bad loop can't take down the rest.

---

## Status

- **P1 — done, fully tested.** Flow primitives (`agent`/`parallel`/`pipeline`/`phase`/`log`/`commit`/`memory`/`args`), the pluggable executor (`claudeCliExecutor` + `fakeExecutor`), the per-run event stream, and the HTTP/WS server (`POST /runs` + `WS /runs/:id/events`).
- **P2 — done, fully tested.** The loop store, per-run budget cap, success-ratcheted cursor, per-loop memory file, the loop runner (failure/budget pause contract), the interval scheduler, and the loop API (`/loops` CRUD + `/loops/:id/trigger` + `/loops/:id/resume`).
- **P3 — roadmap.** Resume UI, human approval gates, mid-run interjection, and cron triggers (the `trigger.kind` is already discriminated for it).

---

## License

MIT — see [LICENSE](./LICENSE).
