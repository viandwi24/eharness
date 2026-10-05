# Spec 05 — Session and storage

Status: **Accepted (reviewed for 0.1.0)**, updated for 0.4.0. Modules: `src/session`, `src/storage` (memory adapters).

eharness knows only `sessionId: string`. Chat lists, titles, owners and permissions belong to the
application.

## 1. Session options

```ts
export interface SessionOptions {
  /** Override agent-level storage for this session. */
  storage?: { messages?: MessageAdapter; state?: StateAdapter }
  /** Developer runtime context, exposed as ctx.runtime (tenantId, userId, feature flags…). */
  runtime?: Record<string, unknown>
  /** AI SDK toolsContext: map keyed by final tool name (spec 01 §4). */
  toolsContext?: Record<string, unknown>
  /** Cross-process mutual exclusion for turns (§8). */
  lock?: SessionLock
  /** Policy for invalid stored messages (spec 03 §7). Default 'drop'. */
  onInvalidMessage?: 'drop' | 'keep' | 'throw'
  /** Keep app-level metadata keys sent by the client on user messages. Default false (§3). */
  acceptClientMetadata?: boolean
  /**
   * Marks a child session (e.g. a subagent run by a tool). Exposed as ctx.session.parent.
   * The core only records it (message metadata `parentId` is unrelated, spec 03 §3) and rejects
   * depth > 8 with EH_CONFIG_INVALID when the session opens (ready() / run error). Child usage is
   * reported to the parent turn with ctx.turn.addUsage() by the plugin that runs the child.
   */
  parent?: { sessionId: string; turnId: string; toolCallId?: string; depth: number }
}
```

`agent.session(id, options)` returns the cached live session when one exists; options passed to a
cached session are merged (`runtime` replaced, others ignored with `W_SESSION_OPTIONS_IGNORED`
when they differ). Cache eviction: `closeSession(id)`, `close()`, or idle eviction
(`config.sessionIdleMs`, default 30 min) which is skipped while a turn runs, a turn is queued (and
can start: a queue held by pending approvals, spec 11 §6.2, does not count), or an `events()` reader
is open. Idle close drops held queued turns like `close()` (`stop: 'aborted'`). After eviction, held references throw `EH_SESSION_CLOSED`; call
`agent.session(id)` again to get a fresh instance. There is never more than one live writer per
id in an agent: `agent.session(id)` called while the previous instance is still closing (its
running turn is aborted and saved, `session.close` hooks run, state is written) returns the new
instance at once, but it opens — and so runs nothing — only after that close finished (no false
crash recovery of the turn that was being closed).

## 2. Session API

```ts
export interface HarnessSession<
  M extends HarnessUIMessage = HarnessUIMessage,
  Kinds extends Record<string, unknown> = HarnessKindTypes,   // kind name → payload (spec 01 §1.2)
> {
  readonly id: string
  readonly running: boolean

  /**
   * Open the session now (state load + plugin session phases) and surface configuration errors
   * (EH_DUPLICATE_*, EH_SERVICE_MISSING, plugin session() failures, EH_STORAGE). Idempotent.
   * Optional: every other method opens lazily.
   */
  ready(): Promise<void>

  /** Start a turn. `input` omitted = continue from history (e.g. after inject). */
  send(input?: SendInput, options?: SendOptions): HarnessRun<M>
  /** Answer pending tool approvals / client tool calls and continue that message (spec 11 §4). */
  respond(response: PendingResponse, options?: SendOptions): HarnessRun<M>
  /** Answer again (spec 11 §5). */
  regenerate(options?: { messageId?: string } & SendOptions): HarnessRun<M>
  /** Replace a user message and answer it (spec 11 §5). */
  edit(messageId: string, input: SendInput, options?: SendOptions): HarnessRun<M>
  /** Replay + follow the running turn (spec 04 §6). */
  attach(): HarnessRun<M> | undefined
  /** Abort the running turn. Partial output is saved with stop 'aborted'. Queued turns are dropped. */
  abort(reason?: string): void

  /** Save a kind message; optionally deliver it into the running turn or wake the agent (spec 11 §6.3). */
  inject<K extends KindName<Kinds>>(kind: K, data: KindData<Kinds, K>, options?: InjectOptions)
    : Promise<{ message: M; run?: HarnessRun<M> }>
  /** Manual compaction (spec 06). Rejects EH_SESSION_BUSY while a turn runs. */
  compact(): Promise<M | null>
  /** Forget session approval grants (spec 11 §3.1). */
  clearGrants(): Promise<void>

  /**
   * Read history for UIs: newest `limit` (default 50) before `beforeId`, chronological. Never
   * compacted. Messages hidden by rewinds (spec 11 §5) are excluded unless `includeHidden`;
   * the core keeps paging back until `limit` visible messages are found or the history is
   * exhausted, so a page never comes back short because of hidden messages. Hot and cold
   * sessions answer the same (a cold read takes the rewinds from the stored state without
   * loading it into the session: no recovery, spec 05 §9).
   */
  messages(q?: { beforeId?: string; limit?: number; includeHidden?: boolean }): Promise<M[]>
  /** Current context stats (spec 06 §2) and pending state (spec 11 §2). */
  stats(): Promise<ContextStats & { pending: PendingState | null; activeTurn: ActiveTurn | null }>

  events(): ReadableStream<SessionEvent>
  /**
   * Resolves when no turn runs and nothing is queued (immediately after close()). A queue held
   * by pending approvals keeps it waiting until respond() (or abort() drops the queue).
   */
  idle(): Promise<void>
  close(): Promise<void>
}

/**
 * Kind names / payload types of a kind payload map. The map of an agent is `AgentKindTypes<C>`,
 * derived from the same config maps that build AgentMessageOf<C> (spec 01 §1.2): core kinds
 * (`HarnessKindTypes`) + app kinds + `<plugin>.<key>` kinds. A message type alone cannot tell kinds
 * from data parts, so the session carries the map as its second type parameter.
 */
export type HarnessKindTypes = { 'eh.compaction': CompactionPayload; 'eh.notice': NoticePayload
                                 'eh.event': EventPayload; 'eh.rewind': RewindPayload }
export type KindName<Kinds> = keyof Kinds & string
export type KindData<Kinds, K extends keyof Kinds> = Kinds[K]

export type SendInput = string | { text?: string; files?: FileUIPart[] } | UIMessage   // a user UIMessage (e.g. from useChat)

export interface SendOptions {
  /**
   * When a turn is already running: throw EH_SESSION_BUSY (default), queue or steer (send() only,
   * spec 11 §6), or 'wait' (send() and respond()): wait for the running turn and the queue ahead,
   * then run (the run is returned at once; its stream starts when the turn starts). A waiting
   * send() is held while approvals created by a turn it waited for are pending — it never
   * denies them (spec 11 §4.1) — and runs after respond(); approvals that were already pending
   * when it was called are handled like a new send(). Its abortSignal drops it while it waits
   * (stop 'aborted', nothing persisted); session abort() keeps it, close() drops it.
   * regenerate/edit always throw EH_SESSION_BUSY while a turn runs.
   */
  ifBusy?: 'reject' | 'queue' | 'steer' | 'wait'
  /** Per-turn overrides (precedence: agent config < SendOptions < turn.prepare < step.prepare). */
  model?: LanguageModel
  settings?: Partial<ModelSettings>
  /** Validated with config.callOptions (spec 01 §1); invalid → EH_INVALID_INPUT. Exposed as ctx.turn.options. */
  options?: unknown
  /** Overrides loop.maxSteps for this turn. */
  maxSteps?: number
  abortSignal?: AbortSignal
  runtime?: Record<string, unknown>          // merged over session runtime for this turn
  toolsContext?: Record<string, unknown>     // merged over session toolsContext
}

export interface InjectOptions {
  deliver?: 'next-turn' | 'next-step'
  wake?: boolean
}
```

**Failure semantics** (normative, identical for `send`, `respond`, `regenerate`, `edit` and the
run returned by `inject(…, { wake })`):

- They throw synchronously only `EH_SESSION_BUSY` (in-process running flag, `ifBusy: 'reject'`)
  and `EH_SESSION_CLOSED`. `handleChatRequest` never throws `EH_SESSION_BUSY`: it returns a failed
  run answering 409 (spec 11 §7).
- A queued run that is dropped (`abort()`, `close()`) never starts: its stream is `start` (throwaway
  id) → `abort`, and `run.result` resolves with `stop: 'aborted'`; nothing is persisted.
- Every other failure — lock not acquired, session open failure, invalid input, pending
  mismatch, storage error, provider error — is reported through the run: the stream is valid
  (`start` → `error` → `message-metadata { stop: 'error' }` → `finish`) and `run.result`
  **resolves** with `{ stop: 'error', error: { code, message } }`. `run.result` never rejects.
- Callers that want configuration errors as exceptions call `await session.ready()` first.
- A failed session open (a plugin `session()` or a tool source `open()` threw) aborts the
  session's `ctx.signal` **before** the disposers of that attempt run (plugin `dispose`, tool
  source `close()`), so per-session resources are released through the normal abort path. The
  session stays usable: the next open attempt gets a fresh `ctx.signal` (unless the session was
  closed meanwhile).

## 3. Turn lifecycle (normative order)

The public method synchronously checks the running flag (or queues/steers, spec 11 §6), sets it,
creates `turnId`, and returns the run. Steps 1–16 run inside the stream's `execute` (spec 04 §2);
the end sequence (step 17) runs in `createUIMessageStream`'s `onEnd`, after `execute` has returned
and the final message is accumulated. Message ids are generated only after the context is
loaded, so they respect the per-session floor and are ordered **rewind < notices < user message
< assistant message**.

**Preparation (nothing is persisted):**

1. Acquire `lock` if configured (reject → `EH_SESSION_BUSY` as a run error). Open the session if
   needed (state load, plugin phases).
2. **Load context** (§5) if the session has no cache; otherwise validate the cache (§6): if the
   adapter has `lastId`, compare before writing anything and on mismatch reload **state and
   messages**. A `respond()` always re-reads the state snapshot here (its answers are checked
   against the freshest `pending`, §8).
3. **Active-turn check** (§9): an `activeTurn` that is not the current turn is either live
   (→ `EH_SESSION_BUSY`) or stale (→ recovered at the commit point).
4. **Operation checks:** `respond` validates against `state.core.pending` (spec 11 §4);
   `send`/`regenerate`/`edit` apply `approval.onNewInput` when something is pending
   (spec 11 §4.1 — `'reject'` ends here with `EH_PENDING_RESPONSE`); `regenerate`/`edit` resolve
   their target (spec 11 §5).
5. Validate `SendOptions.options` against `config.callOptions` and `toolsContext` against the
   tools' `contextSchema`s (spec 01 §4) → `EH_INVALID_INPUT`. The `toolsContext` check runs right
   after step 6, because the contextSchemas of dynamic tools are known only once the turn's tool
   set is resolved.
6. Resolve dynamic sources (spec 02 §5) → `TurnRegistry` (locked for the turn).
7. **Normalize input** (unless omitted):
   - `role` must be `user` (else `EH_INVALID_INPUT`);
   - only `text` and `file` parts are accepted; any other part type (tool parts, `data-*`
     including kinds and `data-eh.*`, reasoning) → `EH_INVALID_INPUT`;
   - file URLs (0.4.0): the protocol must be in `config.inputFiles.protocols` (default
     `['data:', 'https:']`; `javascript:`, `http:`, `ftp:`, `file:` … → `EH_INVALID_INPUT`), and a
     `data:` URL must decode to at most `inputFiles.maxBytes` (default 20 MB). Apps that store
     files behind `http:` URLs (internal object stores) opt in with `protocols`. A file of an
     **earlier** turn whose URL can no longer be downloaded (an AI SDK `DownloadError` before the
     model call, e.g. an expired link) does not break later turns: the step's wire replaces that
     file part with the text `FILE_UNAVAILABLE` (spec 10 §5) and the step is retried (once per
     failing URL; storage is unchanged). A failing file of the current turn stays a run error;
   - client `metadata.eharness` (including any `kind`) is discarded and rebuilt (`v`,
     `createdAt`, `turnId`); a client id is kept as `metadata.eharness.clientId`; other client
     metadata keys are dropped unless `acceptClientMetadata`.
8. **`input.submit` hooks** (chainable, spec 01 §5). A rewrite is normalized again. `context`
   strings are appended as extra `text` parts and `metadata.eharness.augmented` is set to the
   number of parts added (spec 03 §3). A `block` ends the turn with `stop: 'blocked'` and no
   model call: without `persist` it ends here and nothing is persisted; with `persist: true` the
   turn goes through the commit point (steps 10–12, so recovery and pending denial happen as for
   any input), saves the user message and an `eh.notice` (level `warning`, code
   `EH_INPUT_BLOCKED`, the reason), and then ends. A blocked turn creates no assistant message:
   its `start` chunk carries a throwaway id (never stored), `TurnResult.messageId` is undefined and
   `TurnResult.messages` holds the user message and the notice (`turn-end` names the notice id).
9. **`turn.prepare` hooks** → final model, settings and active tools of the turn
   (`ctx.turn.model` / `settings`).
10. **Generate ids** with the floor (spec 03 §8), in this order: the `eh.rewind` marker
    (regenerate/edit), the recovery `eh.notice` (§9, if a stale turn will be recovered), the user
    message (if there is input), then the assistant message (for `respond` the pending message
    keeps its id and nothing new is generated, spec 11 §4). Write
    `start { messageId, messageMetadata: { eharness: { v, createdAt, turnId } } }` (a `respond`
    continuation writes `start { messageId: A.id }` without metadata, spec 04 §2) —
    `run.messageId` resolves here.

**Commit point.** The core sets `committed = true` and from here on the turn has side effects,
written in this order:

11. Recover a stale active turn (§9) and write the new `state.core.activeTurn` together with the
    consumed / denied pending state (spec 11 §4/§4.1) in **one** state write; then save the
    patched pending message (respond / deny) and the `eh.rewind` marker (regenerate/edit).
12. **Save the user message**; append everything saved to the cache.
13. `turn.start` hooks.
14. Pre-turn compaction check (spec 06 §4) with `data-eh.status { state: 'compacting' }`.
15. **Step loop** (architecture §3.4). At every step boundary, in order: deliver waiting steers,
    `next-step` injections and hook context as `data-eh.input` (spec 11 §6; never before the
    first step of a `respond` continuation, spec 11 §4); mid-turn compaction check; guard (sanitize);
    `step.prepare`; guard hard cap for the step's model (spec 06 §6); model call; **step barrier** — wait until `onStepEnd` has updated the cache
    with the step's accumulated message and saved the snapshot (`persistEachStep`, spec 04 §5);
    heartbeat (§9); `step.end`; stop rules (§3.1).
16. **End of `execute`:** answer dangling tool calls (below; also written to the stream as
    `tool-output-error` chunks, so the live UI matches storage); write `message-metadata` (`stop`,
    usage, steps, duration, `pending` — `null` when a continuation resolved it), `setOutcome`,
    and `finish` / `abort` to the AI SDK stream; return. Readers of `run.stream` / `attach()`
    receive everything up to `message-metadata` now; the terminal `finish` / `abort` chunk is held
    back until step 17 completed.
17. **End sequence (in `onEnd`):** `message.beforeSave` + final save; set `state.core.pending`
    when `stop: 'tool-pending'`; clear `activeTurn`; persist state if dirty (§7); update cache;
    emit `turn-end`; `turn.end` hooks; release lock; clear running flag; resolve `run.result`;
    start the next queued turn, if any; **then** write the held-back `finish` / `abort` and close
    `run.stream`. So the end of the stream implies the turn is persisted and the session is free:
    a client that saw `finish` can `send()` immediately (no `EH_SESSION_BUSY`). Every step catches its own errors (a failing final save
    sets `stop: 'error'` / `EH_STORAGE` in `run.result`, spec 10 §1); the lock is always released
    and the running flag always cleared. `turn-end` and `turn.end` belong to committed turns only
    (symmetric with `turn-start` / `turn.start`); an early failure, an early abort or a block
    without `persist` emits only the `status` events.

**Early failure (`committed === false`):** nothing is persisted — no assistant message, no
`eh.notice`, no state write; `onEnd` skips the final save. The stream is `start` (with a throwaway id that is never stored, if
step 10 was not reached) → `error` → `message-metadata { stop: 'error' }` → `finish`. This keeps a
failed lock acquisition from writing into a session another instance owns. In-memory `ctx.state`
changes made by the turn's own preparation (`input.submit`, `turn.prepare`, dynamic tool sources
and instructions — the owner's namespace while its hook runs) are reverted to their value at step
2; every other change made meanwhile — another plugin's `ctx.state`, `clearGrants()`, … — is
kept. When the commit-point state write itself fails, the core fields it changed (`activeTurn`,
`pending`, `grants`, `rewinds`) are put back, so a later write (close, idle eviction) never
publishes a turn that did not commit; on a CAS conflict the in-memory state is discarded and
reloaded from the adapter (the other instance's state wins, nothing of ours overwrites it).

**Later failure (`committed === true`):** the end path runs with `stop: 'error'`, saves the
(possibly empty) assistant message, and additionally saves an `eh.notice` kind (level `error`,
message from `describeError`) — both best effort, since the failure may be the storage itself.
`activeTurn` is cleared if the state write succeeds; otherwise the next operation treats the turn
as stale and recovers it (§9). A `respond` turn that fails after its pending state was consumed
leaves its approved calls unexecuted; they are answered as interrupted (below and spec 03 §6),
never re-executed. On abort: `stop: 'aborted'`, partial saved, no notice. **Timeouts** —
`loop.turnTimeoutMs` (the core aborts the turn internally) and AI SDK step timeouts
(`settings.timeout`) — end like an abort (terminal `abort { reason: 'timeout' }` chunk, outcome
`aborted`) but with `stop: 'timeout'` and an `eh.notice` (level `warning`, code
`EH_TURN_TIMEOUT`).

**Dangling tool calls** (ADR-0014): whenever a turn ends with any stop other than
`'tool-pending'`, every tool part of the assistant message that has no result
(`input-streaming`, `input-available`, `approval-requested`, `approval-responded` not yet
executed) is patched to `output-error` with `errorText` = `INTERRUPTED_TURN` (spec 10 §5) before
the final save. With `'tool-pending'`, only the parts that are pending (spec 11 §2) are left as
they are. Projection and the guard apply the same rule to anything stored by a crashed process
or by older versions (spec 03 §6, spec 06 §6).

### 3.1 Continue vs stop after a step (normative)

Evaluate in this order; the first match decides:

| # | Condition | Stop reason |
|---|---|---|
| 1 | stream `error` part or `finishReason: 'error'` | `'error'` |
| 2 | `finishReason` `'length'` / `'content-filter'` | `'length'` / `'content-filter'` |
| 3 | `finishReason` `'stop'` or `'other'` | `'complete'` |
| 4 | `finishReason: 'tool-calls'` and some tool call of the step is waiting: approval requested by the user-approval path, or a client tool (no `execute`) without output | `'tool-pending'` |
| 5 | a `step.end` hook returned `{ stop }` | `plugin:<plugin>:<reason>` |
| 6 | step count reached the turn's step budget (`maxSteps`, extended by `turn.beforeEnd`) | `'max-steps'` |
| 7 | cumulative output tokens (incl. `addUsage`) > `loop.maxTurnOutputTokens` | `'cost-cap'` |

If none matches (`finishReason: 'tool-calls'` and every call has a result — automatic denials and
tool errors count as results), the loop continues — unless the progress guard (§3.2) found the
turn stuck and has no reminder left, which stops it with `'stuck'`.

Then, before actually stopping:

- **Pending input wins.** If a steer, `next-step` injection or `step.end` `context` is waiting and
  the stop is `'complete'`, the loop continues instead (the input is delivered at the boundary) —
  but only while the step count is below the turn's step budget and the cumulative output tokens
  do not exceed `loop.maxTurnOutputTokens`; otherwise the stop becomes `'max-steps'` /
  `'cost-cap'` (so waiting input can never extend a turn past its limits).
  For every other stop, waiting input is handled as in spec 11 §6.1 (queued turn, or dropped with
  an `input-dropped` event for `'tool-pending'` and `'aborted'`).
- **`turn.beforeEnd`** runs for `'complete'`, `'max-steps'` and `'length'` (spec 01 §5). A
  `continue` result delivers its reason as `data-eh.input` and runs one more step; `extendSteps`
  raises the budget (only for `'max-steps'`). Continuations are bounded by **progress**, not by a
  fixed count (§3.2): a continuation is refused with `W_CONTINUE_LIMIT`
  (`details.reason: 'no-progress'`) once the last `loop.maxIdleContinues` (default 3)
  continuations in a row were followed by no progress. `loop.maxContinues` (default none) is an
  absolute cap on top (`details.reason: 'max'`). `continue` and `extendSteps` both count.
- **Wrap-up.** When the stop is still `'max-steps'` after `turn.beforeEnd` and `loop.wrapUp` is
  on (default), the loop runs **one** more step with `toolChoice: 'none'` (a `step.prepare`
  `toolChoice` cannot change it) and the step reminder `MAX_STEPS_WRAP_UP` (spec 10 §5), so the
  model summarizes what it did and what is left instead of stopping mid-action. That step ends the
  turn with `'max-steps'` whatever it answers (`'error'` stays `'error'`); `turn.beforeEnd` does
  not run for it. The wrap-up step **takes no input**: steers and `next-step` injections waiting
  at its boundary are not delivered into it; when the turn stops they follow the "any other
  stop" rule (a waiting steer becomes a queued `send` turn, spec 11 §6.1).
- `step.end` `context` that is still waiting when the turn stops with anything but `'complete'` is
  discarded: it is plugin context, not user input (no queued turn, no `input-dropped` event).

### 3.2 Progress guard (normative)

Long autonomous turns have no small step cap (`loop.maxSteps` default 500); instead the loop
checks that the turn keeps producing something new. After every step the core records each tool
call of the step as a key of *(tool name, input, output)* — inputs and outputs compared as JSON
with sorted keys; denied calls (`execution-denied`) and `progress.ignoreTools` are skipped. The
last `progress.window` (20) steps that called tools are kept.

- **Repeat:** a key occurring `progress.repeats` (3) times in the window (this also catches A/B
  cycles).
- **Error streak:** `progress.errorStreak` (5) steps in a row whose tool calls all failed
  (`error-text` / `error-json` results).

When the rules of §3.1 would continue and the turn is stuck: while fewer than `progress.nudges`
(1) reminders were given, the next step gets the step reminder `PROGRESS_NUDGE` (spec 10 §5,
never stored), the window and streak are cleared, and `W_LOOP_STUCK` is raised with
`details: { kind, toolName?, count, stepIndex }`. Otherwise the turn stops with `'stuck'`. A step
that ends the turn anyway (§3.1 rules 1–7) is not affected. `loop.progress: false` disables the
guard.

**Progress** for continuations (§3.1) is the number of tool calls whose key was not in the window
and whose result is not an error. A continuation is *idle* when this number did not grow since the
previous continuation; `turn.beforeEnd` receives `idleContinues` (idle continuations in a row,
counting the last one if nothing new happened since). This is measured even when the guard is
disabled.

Stops decided outside a step: `'aborted'` (user/abort signal), `'timeout'`, `'blocked'`
(`input.submit`), `'interrupted'` (set on a recovered message, §9). Full list: spec 10 §4.

## 4. `MessageAdapter` (the storage contract)

```ts
export interface MessageAdapter<M extends UIMessage = UIMessage> {
  /**
   * Chronological (ascending id) messages of a session.
   * - { fromId }            → all messages with id >= fromId (inclusive), no limit; fromId
   *                           need not be a stored id (compare ids, never look up an index)
   * - { beforeId, limit }   → the `limit` newest messages with id < beforeId
   * - { beforeId }          → all messages with id < beforeId
   * - { limit }             → the `limit` newest messages
   * - {}                    → all messages (small sessions / tests only)
   * Passing both fromId and beforeId is invalid.
   */
  load(q: { sessionId: string; fromId?: string; beforeId?: string; limit?: number }): Promise<M[]>
  /** Upsert by id (idempotent). Called with 1..n messages. Order within the call is irrelevant. */
  save(sessionId: string, messages: M[]): Promise<void>
  /** Optional: id of the newest message, for multi-instance cache validation (§6). */
  lastId?(sessionId: string): Promise<string | null>
}
```

Requirements (checked by `messageAdapterConformance()` in `eharness/testing`):

1. Ordering by id string (UUIDv7) — no reliance on insertion order or clocks.
2. `save` is an upsert: same id → **replace** the whole message (`parts`, `metadata`, `role`,
   any other key). Never merge: keys missing from the new version (a resolved `pending`, a
   removed part) must be gone after the save.
3. `fromId` is compared, not looked up: a `fromId` between two stored ids starts at the next
   newer message; `beforeId` without `limit` returns every older message.
4. Round-trips JSON **deep-equal** (no dropped unknown keys, `parts` order preserved; object key
   order may change, e.g. Postgres `jsonb`).
5. `load` returns copies (mutating the result must not change stored data).
6. Sessions are isolated.

Since 0.4.0 the suite checks 2 and 3 explicitly; adapters that merged on save or looked `fromId`
up by index passed earlier versions of the suite and now fail it (they were wrong).

Stored history is **append-only from the core's point of view**: the core upserts messages it
owns (the running assistant message, patches of a pending message, recovery patches) but never
deletes. Regenerate/edit hide messages with `eh.rewind` markers (spec 11 §5). Deleting data is the
application's business (e.g. deleting a chat).

The library ships `memoryMessages()` only. Everything else is application code (see §10, examples).

## 5. Loading the model context (fixed algorithm)

The core keeps a **compaction pointer** in core state: `{ markerId, resumeFromId }` of the newest
`eh.compaction` marker (spec 06).

```
loadContext(sessionId):
  if hot cache valid → return cache                                                  (§6)
  ptr = state.core.compaction
  if ptr:
    msgs = adapter.load({ sessionId, fromId: ptr.resumeFromId ?? ptr.markerId })     (1 query)
    if no boundary in msgs: fall back to paging (below)       ← history changed behind our back
  if !ptr or fallback:
    msgs = []
    page backwards with load({ sessionId, limit: 100, beforeId: oldest(msgs) }) until
      a boundary B is loaded AND (B's payload.resumeFromId == null OR some loaded id <= payload.resumeFromId),
      or history is exhausted
  validate each message (spec 03 §7)
  B = newest boundary in msgs (by id)                    ← may be newer than ptr (crash healing)
  if no B: view = msgs (non-boundary, id order); delete ptr if set (state dirty)
  else:
    payload = B.parts[0].data                            ← CompactionPayload (spec 06 §3)
    start = payload.resumeFromId ?? B.id
    view  = [B] + msgs.filter(m => !isBoundary(m) && m.id >= start)      ← older markers dropped
    if !ptr || ptr.markerId !== B.id: ptr = { markerId: B.id, resumeFromId: payload.resumeFromId } (state dirty)
    if payload.partial: projection trims that message's early steps (spec 03 §6 step 1)
  view = view.filter(m => !hiddenByRewind(m, rewindsIn(msgs)))        ← spec 11 §5 view rule
  heal state.core.rewinds / state.core.activeTurn from msgs if they disagree (state dirty)
  cache = view
```

Notes:

- `resumeFromId` points to the first message kept verbatim by that compaction. The marker has a
  newer id than the kept messages; it is moved to the front of the view.
- Pointer path correctness when the stored pointer is **stale** (marker saved, state write lost,
  spec 06 §5.4): the `fromId` range starts at the older `resumeFromId`, so it still contains the
  newer marker; step "B = newest boundary" picks it and the filter removes everything it
  summarized. The pointer is then healed.
- If `resumeFromId` is `null` (manual compaction of everything) the view starts at the marker.
- A rewind always has a newer id than the messages it hides, so whenever a hidden message is
  loaded its rewind is loaded too; the rewind filter needs no extra query. `state.core.rewinds`
  exists for `session.messages()` paging, where the rewind may be newer than the page.

## 6. Hot cache

- A live session keeps its assembled view in memory and appends new/updated messages as they are
  saved. The running assistant message is updated in the cache from `onStepEnd` at every step
  (the step barrier, §3) **whether or not** `persistEachStep` is on, so compaction and projection
  always see the live message. Turns on a hot session perform **no reads** (except the state
  re-read of `respond()`).
- Cold load happens on first use after process start, eviction, or invalidation.
- Multi-instance deployments: if the adapter implements `lastId`, the core compares it with the
  cached newest id at turn start **before writing anything** (lifecycle step 2). On mismatch it
  reloads **both** the state snapshot and the messages.
- `lastId` does not change when the core only patches an existing message (e.g. `respond()`), so
  `lastId` alone cannot detect every foreign change; `respond()` therefore re-reads state, and
  exact multi-instance correctness needs a `SessionLock` or a CAS-capable `StateAdapter` (§7–8).
- Message validation runs only on cold loads.
- **Single-flight load.** Concurrent operations of a cold session (`stats()`, `inject()`,
  `send()`, …) share one in-flight load of state and messages; the state is read at most once
  per load, so in-memory changes made after it (e.g. `ctx.state` in `session.start`, a
  turn's commit) are never overwritten by a second read. Messages saved while a load is in
  flight are merged into the loaded view (the load may have read storage before them).

## 7. State

```ts
export interface StateAdapter {
  get(sessionId: string): Promise<SessionStateSnapshot | null>
  set(sessionId: string, state: SessionStateSnapshot): Promise<void>
  /**
   * Optional compare-and-set: write only if the stored `rev` equals `expectedRev` (null = no
   * snapshot yet). Returns false on conflict. Used for the commit-point write (§3 step 11).
   */
  setIf?(sessionId: string, state: SessionStateSnapshot, expectedRev: number | null): Promise<boolean>
}

export interface SessionStateSnapshot {
  v: 1
  /** Incremented by the core on every write. */
  rev: number
  core: {
    compaction?: { markerId: string; resumeFromId: string | null }
    /** Cumulative over the session; `turns` counts turns that ran at least one model step. */
    usage?: { inputTokens: number; outputTokens: number; turns: number; costUsd?: number }   // costUsd: spec 12
    /** The turn currently running somewhere (§9). */
    activeTurn?: ActiveTurn
    /** Approvals / client tool calls waiting for respond() (spec 11 §2). */
    pending?: PendingState
    /** Session approval grants (spec 11 §3.1). */
    grants?: Record<string, 'always' | 'never'>
    /** Mirror of eh.rewind markers (spec 11 §5); the markers are the source of truth. */
    rewinds?: Array<{ afterId: string | null; rewindId: string }>
  }
  plugins: Record<string, Record<string, JSONValue>>    // plugins[<plugin name>][key]
}

export interface PluginState {
  get<T extends JSONValue = JSONValue>(key: string): T | undefined
  set(key: string, value: JSONValue | undefined): void   // undefined deletes
}
```

- `ctx.state` is namespaced per plugin (`plugins[<name>][key]`; root plugin = `app`).
- The commit-point write (§3 step 11) uses `setIf` when the adapter has it; a conflict ends the
  turn as an early failure with `EH_SESSION_BUSY` (another instance changed the session: e.g.
  consumed the same pending answers). `stateAdapterConformance()` checks `setIf` when present.
- Loaded once at session open (and on cache invalidation); written at the commit point
  (`activeTurn`), during the turn only for heartbeats (§9), at the end of each turn, after
  compaction, after `respond()` consumes pending state, and on `close()` — only if something
  changed (dirty flag).
- Must stay small (guideline < 64 KB). Large data belongs in the plugin's own storage.
- Without a persistent `StateAdapter` (memory default) sessions still work after restart; they
  lose plugin state (e.g. file staleness info), pending approvals (a later `respond()` fails with
  `'unknown-id'`; `send()` simply continues) and fall back to paging for context loading.

## 8. Concurrency and locking

- In-process: one running turn per session (`EH_SESSION_BUSY`, or `ifBusy` queue/steer);
  `compact()` is also exclusive.
- **Exactly-once approvals across instances** (spec 11 §8) require either a `SessionLock` or a
  `StateAdapter` with `setIf`. Without both, a replayed `respond()` that reaches two instances at
  the same moment can be accepted twice; within one process it cannot.
- Cross-process without a lock: `state.core.activeTurn` with a fresh heartbeat makes a second
  instance fail with `EH_SESSION_BUSY` (best effort — two instances can still race between read
  and write).
- Cross-process with a lock (exact):

```ts
export interface SessionLock {
  /** Try to acquire for the duration of a turn. Resolve with a release function, or reject if
   *  the session is locked elsewhere (→ run error EH_SESSION_BUSY). Must not block indefinitely. */
  acquire(sessionId: string, opts: { signal: AbortSignal }): Promise<() => Promise<void>>
}
```

Postgres example: `SELECT pg_try_advisory_lock(hashtextextended($1, 0))` on a dedicated
connection; reject when it returns `false`; release with `pg_advisory_unlock` in the returned
function. The library ships no lock implementation.

## 9. Crash recovery

A process can die in the middle of a turn (deploy, OOM, serverless timeout). The stored assistant
message then has no `stop`, may contain tool calls without results, and the session would look
"running" forever. eharness detects and repairs this on the next operation.

```ts
export interface ActiveTurn {
  turnId: string
  kind: TurnInfo['kind']
  messageId: string                 // assistant message of the turn
  userMessageId?: string
  owner: string                     // random id of the agent instance (per process)
  startedAt: number                 // epoch ms
  heartbeatAt: number               // epoch ms
}
```

- Written at the commit point, cleared at the end of the turn. While the turn runs, `heartbeatAt`
  is refreshed (one state write) whenever the last write is older than `recovery.staleMs / 4` —
  checked at step ends and by a timer, so long tool calls keep it fresh. Turns shorter than
  `staleMs / 4` write no heartbeat.
- At the start of an operation (lifecycle step 3), an `activeTurn` is **stale** if
  - it belongs to this process (`owner`) but no turn of this session is running here (e.g. the
    end-of-turn state write failed), or
  - a `SessionLock` was acquired (the owner lost its lock, so it is gone), or
  - `now - heartbeatAt > recovery.staleMs` (default 120 000).
  Otherwise the operation fails with `EH_SESSION_BUSY`.
- **Recovery** (at the commit point): if the assistant message exists, answer its dangling tool
  calls (§3 rule, `errorText` = `INTERRUPTED_CRASH`, spec 10 §5),
  set `metadata.eharness.stop = 'interrupted'` and save it; save an `eh.notice` (level `warning`,
  code `EH_TURN_INTERRUPTED`); clear `activeTurn`; emit `turn-end` with `stop: 'interrupted'`.
  Then the operation continues normally. Tools that were running are **not** re-executed.
- Reads (`messages()`, `stats()`) never recover; UIs see the unfinished message until the next
  operation. `stats()` reports `activeTurn` so a UI can show "interrupted / resume".
- `config.recovery: false` disables tracking (one state write less per turn); a crashed turn then
  stays unfinished in storage, but projection still answers its dangling calls.

## 10. Reference: Postgres (application code, not shipped)

```sql
CREATE TABLE eh_messages (
  session_id  text        NOT NULL,
  id          uuid        NOT NULL,        -- UUIDv7 from eharness
  role        text        NOT NULL,
  parts       jsonb       NOT NULL,
  metadata    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, id)
);

CREATE TABLE eh_session_state (
  session_id  text PRIMARY KEY,
  state       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
```

```sql
-- load { fromId }
SELECT id, role, parts, metadata FROM eh_messages
WHERE session_id = $1 AND id >= $2 ORDER BY id;

-- load { beforeId, limit }   (reverse in code)
SELECT id, role, parts, metadata FROM eh_messages
WHERE session_id = $1 AND id < $2 ORDER BY id DESC LIMIT $3;

-- save (per message, or unnest() for batches)
INSERT INTO eh_messages (session_id, id, role, parts, metadata)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (session_id, id) DO UPDATE
  SET role = EXCLUDED.role, parts = EXCLUDED.parts, metadata = EXCLUDED.metadata;

-- lastId
SELECT id FROM eh_messages WHERE session_id = $1 ORDER BY id DESC LIMIT 1;
```

The composite primary key makes every query an index range scan. Postgres `uuid` ordering is
byte-wise, which equals UUIDv7 time ordering. A full runnable version lives in
`examples/postgres-storage.ts` (conformance-tested on Postgres 17). Bind JSON as text
(`$4::text::jsonb`) and select it as text: some drivers JSON-encode a string bound to a `jsonb`
parameter a second time.

## 11. Performance expectations

| Path | I/O |
|---|---|
| Hot turn | 0 reads; 1 upsert (user) + 1 upsert per step (assistant) + 1 final upsert; 2 state writes (commit point, end) + heartbeats for turns longer than `staleMs / 4` |
| Hot turn, `recovery: false` | as above with ≤ 1 state write |
| Cold turn | 1 state read + 1 range query (with pointer) |
| UI history page | 1 range query |

Write amplification: `persistEachStep` rewrites the whole assistant message per step. Mitigations:
tool output limits (spec 09 §4) and plugin transforms (`tool.after` / `message.beforeSave`);
adapters may store per-step rows internally without changing the contract.
