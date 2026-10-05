# Spec 04 — Streaming

Status: **Accepted (reviewed for 0.1.0)**, updated for 0.4.0. Module: `src/stream`.

## 1. One protocol

The only streaming protocol is the **AI SDK UI message stream** (`ReadableStream<UIMessageChunk>`,
served as SSE by `createUIMessageStreamResponse`). Web clients (`useChat`), the terminal
(`readUIMessageStream`), tests and persistence all consume the same chunks. There is no second
event format.

Notation: `AgentMessage` = `InferHarnessUIMessage<typeof agent>` (spec 03 §2), i.e.
`AgentMessageOf<C>` of spec 01 for that agent's config.

## 2. Turn stream structure

Each turn produces exactly one stream for exactly one assistant message. `start` is written after
the preparation phase of the lifecycle (spec 05 §3 steps 1–10), because the assistant id must be
generated after the user id:

```
start { messageId: <assistant UUIDv7>, messageMetadata: { eharness: { v: 1, createdAt, turnId, parentId } } }
  data-eh.status (transient) { state: 'compacting' }        ← only if pre-turn compaction runs (no `step`)
  data-eh.status (transient) { state: 'thinking', step: 0 }
  start-step
    reasoning-* / text-* / tool-input-* / tool-approval-request / tool-output-* / source-* / file / data-* …
  finish-step
  data-eh.usage (transient) · data-eh.context (transient)
  data-eh.input { source, text, … }                         ← steer / next-step inject / hook context (spec 11 §6)
  … more steps …
message-metadata { eharness: { model, usage, stop, steps, durationMs, pending? } }
finish                                  ← normal end
abort { reason }                        ← instead of `finish` when aborted (user abort, turn timeout)
```

The transient `data-eh.status { state: 'tool' }` chunk is written by the core's execute wrapper
when a tool starts; with recent AI SDK versions (observed with 7.0.127) a tool can start before its step's
`start-step` chunk reaches the stream, so the status may precede `start-step` (transient: it never
changes the message). `finish` / `abort` reach `run.stream` only after the turn's end sequence
completed (spec 05 §3 step 17).

Turn kinds (spec 01 `TurnInfo.kind`) differ only at the start:

| Kind | Assistant message | Stream start |
|---|---|---|
| `send`, `regenerate`, `edit`, `wake`, `queue` | new | `start` with a new id |
| `respond` | the pending message A, **continued** | `createUIMessageStream({ originalMessages: [A'] })` where A' is the patched stored A (spec 11 §4); `start { messageId: A.id }` without metadata (A's `createdAt`/`turnId` are kept); the first chunks are `tool-output-available` / `tool-output-error` for client tool answers (written by the core) and `tool-output-available` / `tool-output-denied` for the answered approvals (AI SDK), **before** any `start-step` |

A continuation must stream into the existing UI message: a fresh message fails in AI SDK with
`No tool invocation found for tool call ID`. `usage` and `steps` in the final metadata are
cumulative over all turns that wrote the message.

The core creates the `createUIMessageStream` when it writes `start` (a continuation only knows A'
after the commit point). Transient chunks written earlier (warnings of the preparation) follow
`start`, so every turn stream begins with `start`.

Built with (normative shape):

```ts
const stream = createUIMessageStream<AgentMessage>({
  generateId,                         // UUIDv7 (spec 03 §8)
  originalMessages,                   // [A'] for respond(), undefined otherwise
  onError: describeError,             // errors thrown inside execute (spec 10 §3)
  // cache update + snapshot save; resolves the step barrier the loop awaits (spec 05 §3 step 15)
  onStepEnd: ({ responseMessage }) => onStep(responseMessage),                   // §5
  // final save + end sequence (spec 05 §3 step 17); skipped saves when !committed
  onEnd: ({ responseMessage, isAborted }) => endTurn(responseMessage, isAborted),
  execute: async ({ writer }) => {
    // spec 05 §3 steps 1–9: lock, load, checks, sources, normalize, input.submit, turn.prepare
    // step 10: ids (rewind, notices, user, assistant; per-session floor) → start
    writer.write({ type: 'start', messageId, messageMetadata: { eharness: { v: 1, createdAt, turnId, parentId } } })
    // steps 11–14 … (early failures before step 11: start with a throwaway id → error → finish, nothing saved)
    for each step:
      const result = streamText({ …, stopWhen: isStepCount(1), abortSignal: turnSignal })
      for await (const chunk of toUIMessageStream({
        stream: result.stream, tools, sendStart: false, sendFinish: false,
        onError: uiErrorText,         // MUST be set here too: toUIMessageStream has its own default
      })) {
        if (chunk.type === 'abort') { stepAborted = true; continue }   // the core writes the single terminal abort
        writer.write(chunk)
      }
      let response: ModelMessage[] | undefined
      try { response = await result.responseMessages } catch { /* aborted / doStream failed (§8) */ }
      await stepBarrier()               // onStepEnd has run for this step's finish-step (if any)
      // the step is complete only here
    writer.write({ type: 'message-metadata', messageMetadata: { eharness: { … } } })
    writer.setOutcome(outcome)          // { status: 'completed' | 'aborted' } or { status: 'failed', error }
    writer.write(aborted ? { type: 'abort', reason } : { type: 'finish' })
  },
})

/** Tool errors: the exact text the model gets (String(error)), so UI and replay match the wire. */
// HarnessToolError copies name + message of the original error, so String(e) equals what the wire got.
// Same for InvalidToolInputError / NoSuchToolError (and the string AI SDK passes for them next).
const uiErrorText = (e: unknown) => (isToolCallError(e) ? String(e) : describeError(e))
```

Rules:

- Steps are copied with `for await … writer.write`, **not** `writer.merge`: `merge` drains in its
  own async loop and would interleave step chunks with the core's following writes, making the
  chunk order (public API) non-deterministic.
- Only the core writes `start`, `message-metadata`, `finish`, `abort` and `data-eh.input`.
  Plugins never do.
- Plugin writes during a step (§3), including writes from inside a tool's `execute`, race with the
  forwarded model chunks: their position relative to model chunks of the same step is
  best-effort. Data that must be part of a step's snapshot (`onStepEnd`) must be written before
  that step's `finish-step`; anything written later lands in the next snapshot or the final save.
- `reset-step` (emitted when AI SDK retries a step with `streamRetries`) is forwarded unchanged;
  the accumulator on both sides discards the partial step. The core also discards step-local
  bookkeeping of the failed attempt (tool-search discoveries, usage).
- An `abort` chunk from `toUIMessageStream` while the turn signal is **not** aborted comes from an
  AI SDK step timeout (`settings.timeout`); the core ends the turn with `stop: 'timeout'`.
- `result.responseMessages` rejects on abort and when the provider call failed before streaming
  (`doStream` threw): the core never awaits it unguarded (§8).
- The core calls `writer.setOutcome` (otherwise AI SDK reports `outcome: 'unknown'`).
- Early failures (lock not acquired, session open failed, invalid input) still produce a valid
  stream: `start` → `error` → `message-metadata { stop: 'error' }` → `finish` (spec 05 §2).

## 3. Plugin stream writer

```ts
export interface PluginStreamWriter<DP extends DataPartMap = {}> {
  /** True while a turn stream is open. */
  readonly active: boolean
  /** Write a data part declared by THIS plugin (name is the local key, type-checked). */
  data<K extends keyof DP & string>(name: K, data: InferSchema<DP[K]['schema']>, opts?: { id?: string; transient?: boolean }): void
  /** Escape hatch: write any registered data chunk, un-namespaced (the full `data-…` type). */
  write(chunk: Extract<InferUIMessageChunk<AgentMessage>, { type: `data-${string}` }>): void
}
```

- `ctx.stream.data('change', {...}, { id: path })` → `{ type: 'data-filesystem.change', id, data }`.
- `transient` defaults to the part definition's `transient`. Passing `transient: false` for a part
  defined as transient raises `W_TRANSIENT_OVERRIDE` and the part is sent as transient
  (`config.strict: true` turns this and other misuse warnings into thrown `EH_CONFIG_INVALID`).
- `write(chunk)` is an **un-namespaced escape hatch**: it accepts the full part type of any
  registered data part or kind (core, app or another plugin's), so a plugin can write parts it does
  not own; only the core-only `data-eh.input` is refused.
- Writing a data part that is not registered → `W_UNKNOWN_DATA_PART`, dropped. The core-only
  `data-eh.input` part is treated the same way when a plugin writes it (§2: only the core writes it).
- **Outside a turn** (`active === false`): transient writes go to the session event channel (§6);
  persistent writes are rejected with `W_WRITE_OUTSIDE_TURN` (use `session.inject` for durable
  out-of-turn content).
- Tools use the same writer through the `ctx` they closed over (spec 01 §4) — no `emit` plumbing.
  Tool functions are typed with their owner's parts: a plugin's `dataParts` for tools it
  contributes (setup or session phase), the app's `dataParts` for top-level `tools`.

## 4. Persistent vs transient vs metadata (normative guidance)

| Use | Mechanism |
|---|---|
| Live progress, spinners, counters, context meter, warnings | transient data part |
| Content the user must see after reload (file changed, report card, artifact) | persistent data part (with `id` for updates) |
| Message-level facts (model, usage, stop reason, duration) | `metadata.eharness` via `start` / `message-metadata` |
| Non-model messages (compaction, notices, events) | message kind (spec 03 §5) |

## 5. Server-side accumulation and persistence

The stored assistant message is built by AI SDK itself from the same chunks the client receives:

- `createUIMessageStream({ onStepEnd, onEnd })` — `onStepEnd` fires on every `finish-step` with the
  accumulated `responseMessage` (always the same message id; metadata from `start` and
  `message-metadata` is deep-merged); `onEnd` fires once with the final message and `isAborted`.
- `onStepEnd` → `message.beforeSave` hooks → `MessageAdapter.save` (only when
  `persistEachStep`). `onEnd` → hooks → final `save` (always). Aborted steps, timed-out steps and
  provider calls that failed before streaming emit no `finish-step`, so `onEnd` is the only
  place that is guaranteed to persist them.
- `onStepEnd` and `onEnd` run in AI SDK's output pipeline, **not** inside `execute`: `onStepEnd`
  when the core-drained branch reads `finish-step`, `onEnd` after `execute` returned and the
  stream closed. The loop therefore awaits a per-step barrier that `onStepEnd` resolves (steps
  without `finish-step` resolve it immediately), and the end sequence of the turn lives in
  `onEnd` (spec 05 §3 steps 15–17).
- `onStep` / `endTurn` must catch their own errors (AI SDK routes callback errors to
  `onError` and ignores the result) and implement the retry / `EH_STORAGE` rules of spec 10 §1
  themselves. `endTurn` skips all saves and state writes when the turn never reached the commit
  point (`committed === false`, spec 05 §3).
- These callbacks run only while the stream is read. The core therefore **drains the
  `createUIMessageStream` output itself**, and `run.stream` is a reader of the turn buffer (§6)
  (like `attach()`, from the first chunk). A turn never stalls and is always persisted even if the
  client never reads or disconnects (the turn buffer holds the chunks until the turn ends).
- Transient parts never enter `responseMessage.parts` (AI SDK behaviour), so they are never stored.
- **Chunks are mutated after they are written.** AI SDK reconciles data parts by `type` + `id` by
  mutating the part object, and the written chunk *is* that object. The core therefore
  `structuredClone`s every chunk **when it writes it** into the turn buffer (§6), and every
  buffer reader (`run.stream`, `attach()`) gets its own copy of each chunk, so consumers see each
  chunk exactly as it was written. (A `tee()` of the output would share — and buffer — the
  mutable objects, so the caller branch could observe later reconciliations.)

Because the stored message is produced by the same reader logic the client uses, reconciliation,
ordering and part shapes are identical on both sides (ADR-0003).

## 6. Turn buffer, attach and session events

- Every chunk of the running turn is appended (cloned, §5) to an in-memory **turn buffer**
  (cleared when the next turn starts).
- `session.attach(): HarnessRun | undefined` returns a run whose `stream` replays the buffer from
  the start and then follows live chunks; `undefined` when idle. This is the reconnect path (new
  tab, dropped SSE). Cross-process resume is out of scope for v0 (the buffer is per process).
- `session.events(): ReadableStream<SessionEvent>` — long-lived channel for things that happen
  outside a turn stream. A session with an open `events()` reader is not idle-evicted.

- For a `respond()` continuation the buffer holds only the continuation chunks. A client that
  resumes it with `useChat` should re-fetch the message when the turn ends (spec 11 §7).
- `send(…, { ifBusy: 'steer' })` returns `attach()` of the running turn.

```ts
export type SessionEvent =
  | { type: 'turn-start'; turnId: string; messageId: string; kind: TurnInfo['kind']; queued: boolean }
  | { type: 'turn-end'; turnId: string; messageId: string; stop: StopReason }
  | { type: 'pending'; pending: PendingState | null }       // spec 11 §2
  | { type: 'input-dropped'; reason: 'tool-pending' | 'aborted' | 'blocked'; text: string; clientId?: string }  // spec 11 §6.1
  | { type: 'message'; message: AgentMessage }               // injected kinds, compaction markers
  | { type: 'data'; chunk: Extract<InferUIMessageChunk<AgentMessage>, { type: `data-${string}` }> }
  | { type: 'status'; running: boolean }
  // durable inbox (0.4.0, spec 05 §12): an item was stored by this process / applied (acked) here
  | { type: 'inbox-enqueued'; inboxId: string; kind: 'send' | 'wake' | 'abort'; mode?: 'queue' | 'steer' | 'collect' }
  | { type: 'inbox-drained'; inboxIds: string[]; turnId?: string }
```

## 7. `HarnessRun` and responses

```ts
export interface HarnessRun<M extends HarnessUIMessage = HarnessUIMessage> {
  readonly turnId: string
  readonly kind: TurnInfo['kind']
  /** Assistant message id; resolves when `start` is written (spec 05 §3 step 10). */
  readonly messageId: Promise<string>
  /** The UI message stream. Single consumer; use tee() if you need more. */
  readonly stream: ReadableStream<InferUIMessageChunk<M>>
  /** Resolves after the turn is fully persisted. Never rejects (spec 05 §2, spec 10). */
  readonly result: Promise<TurnResult<M>>
  abort(reason?: string): void
  /** createUIMessageStreamResponse({ stream }) with UI_MESSAGE_STREAM_HEADERS. */
  toResponse(init?: ResponseInit): Response
  /** pipeUIMessageStreamToResponse for Node's ServerResponse (typed without importing node:). */
  pipeTo(response: Parameters<typeof pipeUIMessageStreamToResponse>[0]['response']): Promise<void>
}
```

Typical route (works with `useChat`'s default request body `{ id, messages, trigger, messageId }`):

```ts
export async function POST(req: Request) {
  const body = await req.json()
  const session = agent.session(body.id, { runtime: { userId } })
  return handleChatRequest(session, body).toResponse()   // send / respond / regenerate / edit (spec 11 §7)
}
export async function GET(req: Request) {        // reconnect (useChat resume)
  const id = new URL(req.url).searchParams.get('id')!
  const run = agent.session(id).attach()
  return run ? run.toResponse() : new Response(null, { status: 204 })
}
```

The server owns history: only the last message and the decision fields of an assistant message
(approval answers, client tool outputs) are read. The user message is re-created server-side
(spec 05 §3), so a client cannot rewrite history by sending old messages.

Headless:

```ts
const run = session.send('refactor the strategy')
for await (const msg of readUIMessageStream({ stream: run.stream })) render(msg)
const { stop, usage } = await run.result
```

## 8. Errors in the stream

Verified AI SDK v7 behaviour and what the core does with it:

| Situation | What AI SDK does | Core |
|---|---|---|
| Tool `execute` throws | `tool-output-error` chunk; the wire gets `error-text` = `String(error)`; the step continues | UI text = the same `String(error)` (`uiErrorText`); the loop continues |
| Tool input fails the tool's schema / unknown tool | `tool-input-error` + `tool-output-error` chunks; the wire gets `error-text` = `String(error)` (`AI_InvalidToolInputError: …` / `AI_NoSuchToolError: …`); `onError` is called with the error, then with that text | UI text = the same `String(error)` for both chunks; the loop continues |
| Provider stream emits an `error` part | `error` chunk, stream continues, `finishReason: 'error'`, `responseMessages` resolves with the partial output | stop `'error'` after the step |
| Provider call throws before streaming (`doStream`) | one `error` chunk, no `start-step`/`finish-step`, `responseMessages` rejects | stop `'error'`; nothing appended to the wire |
| Invalid `toolsContext` for a tool | stream-level `error`, the tool call has **no result** | prevented by up-front validation (spec 01 §4); dangling calls are answered (spec 05 §3) |
| Abort signal / AI SDK timeout | `abort` chunk, no `finish-step`, `responseMessages` rejects | stop `'aborted'` / `'timeout'`; dangling calls answered; final save in `onEnd` |
| Error thrown inside `execute` (core bug, storage) | `error` chunk from `createUIMessageStream`'s `onError` | caught by the core first: stop `'error'` + `eh.notice` |
| Context overflow from the provider | error | compact and retry once (spec 06 §7), else stop `'error'` with `EH_CONTEXT_OVERFLOW` |

- Error texts come from `describeError` (spec 10 §3); it never leaks stack traces or provider
  payloads.
- The stream always ends with exactly one `finish` or one `abort`, never left hanging.
