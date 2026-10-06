# Spec 11 — Interaction: approvals, client tools, regenerate/edit, steering, wake

Status: **Accepted (reviewed for 0.1.0)**, updated for 0.5.0. Modules: `src/session/interaction/*`, `src/stream/chat-request.ts`.

This spec covers everything a user (or a UI) does to a session besides "send a new message":
answering tool approvals, returning client-side tool results, regenerating or editing, talking to
the agent while it works, and waking it from background work. All of it is designed around the
AI SDK v7 `useChat` protocol and keeps the invariant **stored history order = the order the model
saw** (ADR-0011).

## 1. Session operations (overview)

| Operation | Purpose | Starts a turn |
|---|---|---|
| `send(input?, opts)` | new user input (or continue from history) | yes (or queue/steer, §6) |
| `respond(response, opts)` | answer pending approvals / client tool calls | yes — continues the pending assistant message |
| `regenerate(opts)` | answer the last (or a given) user message again | yes |
| `edit(messageId, input, opts)` | replace a user message and answer it | yes |
| `inject(kind, data, opts)` | add a non-model message (event/notice) | only with `wake` |
| `enqueue(input, opts)` | hand input to the instance holding the session (spec 05 §12) | yes, there (queue / steer / collect) |
| `abort(reason)` | stop the running turn | — |

`handleChatRequest()` (§7) maps a `useChat` request body onto these operations.

## 2. Pending state

A turn that ends with `stop: 'tool-pending'` leaves the session **pending**:

```ts
export interface PendingState {
  messageId: string                                   // the assistant message waiting for answers
  approvals: Array<{ approvalId: string; toolCallId: string; toolName: string; input?: unknown; risk?: ToolRisk; idempotent?: boolean }>  // input/risk since 0.3, idempotent since 0.5 (§3.2)
  clientTools: Array<{ toolCallId: string; toolName: string }>
}
// state.core.pending: PendingState (spec 05 §7) — authoritative, used to validate respond()
// metadata.eharness.pending: PendingState | null on the assistant message — copy for UIs;
//   set to null when the pending state is resolved (respond / onNewInput deny)
```

`tool-pending` is decided at step end (spec 05 §3.1): a tool part in state `approval-requested`
whose request is **not** automatic, or a call to a tool without `execute` (client tool) with no
output. Automatic denials (`output-denied`, `isAutomatic`) are results, not pending.

## 3. Tool approval

Built on AI SDK v7 `streamText({ toolApproval })` (tool-level `needsApproval` is deprecated in v7
and must not be used by eharness code).

**AI SDK re-validates approved calls** when a continuation starts (`validateApprovedToolApprovals`):
it re-verifies the signature (`approval.secret`), re-runs `experimental_refineToolInput` on the
request's `inputSchemaInput` (the input before refinement, stored on the approval object when the
refinement changed the input; otherwise the stored input) and requires the result to deep-equal
the stored (refined) input, and calls `toolApproval` again (a `denied` now denies the call).
Consequences, normative for eharness:

- `tool.before` hooks must be **deterministic** (the same input always gives the same result)
  and, for requests without `inputSchemaInput` (stored by older AI SDK versions), idempotent;
  otherwise the approved call is rejected as invalid input (a tool error result, never executed).
- The approval function (below) runs a second time for approved calls; policies and
  `tool.approve` hooks must be deterministic and side-effect free.
- Stored approval objects are patched by merging, never replaced (`signature` and
  `inputSchemaInput` must survive, §4).

```ts
defineHarnessAgent({
  approval?: {
    /** Static policy; same shape as AI SDK ToolApprovalConfiguration (per-tool map or generic function). */
    policy?: ToolApprovalConfiguration<ToolSet, unknown>
    /** Status per tool risk (§3.2); `unknown` = tools without a risk. */
    risk?: Partial<Record<ToolRisk | 'unknown', ToolApprovalStatus>>
    /** Passed as experimental_toolApprovalSecret: HMAC-signs requests; responses are verified. */
    secret?: string
    /** What send()/regenerate()/edit() do while approvals are pending. Default 'deny'. */
    onNewInput?: 'deny' | 'reject'
  },
})
```

Per step the core builds **one** `GenericToolApprovalFunction` and passes it as `toolApproval`:

1. `approval.policy` result (per-tool entry or generic function);
2. `approval.risk[risk ?? 'unknown']` (§3.2);
3. every `tool.approve` hook (spec 01 §5), in plugin order (the event carries the traits:
   `risk`, `idempotent`, `hints`, §3.2);
4. session grants (§3.1).

Results are normalized to `{ type, reason? }` and combined **most restrictive wins**:
`denied` > `user-approval` > `approved` > `not-applicable`. A hook or policy that throws, or
that returns an unknown status (e.g. a typo such as `'deny'`), counts as `denied` (fail closed,
reason `invalid approval status '<value>'`). The approval function sees the input **after** `tool.before` refinement
(AI SDK runs `experimental_refineToolInput` before approval).

### 3.1 Grants

`respond({ approvals: [{ id, approved, remember: 'session' }] })` stores
`state.core.grants[toolName] = 'always' | 'never'`. At step 3 above: `never` → `denied`;
`always` turns a `user-approval` into `approved` but never overrides `denied`. Grants are
per session, cleared by `session.clearGrants()`, and the grants recorded by a `respond()` take
effect **after the first step of its continuation** (so AI SDK's re-validation of the calls just
answered is not affected by them; grants recorded earlier apply from step 0). A grant is recorded
in the commit-point state write of the `respond()` that carries it.
A grant that can never apply (the policy or a hook returns `denied` for that tool) raises
`W_GRANT_IGNORED` once.

### 3.2 Tool risk

```ts
export type ToolRisk = 'read' | 'write' | 'destructive' | 'external'   // 'external' since 0.5.0

export interface ToolTraits {
  risk?: ToolRisk
  /** Only from app metadata (`metadata.idempotent`); absent = unknown. */
  idempotent?: boolean
  /** Raw MCP hints as the server sent them (untrusted), for app policies and UIs. */
  hints?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }
}
export function toolTraits(metadata: unknown): ToolTraits   // pure, never throws
```

A tool declares its traits in AI SDK's tool metadata: `tool({ …, metadata: { risk?, idempotent? } })`
(AI SDK surfaces it as `toolCall.toolMetadata`). `'external'` means the call has an effect outside
the system (sends an email, posts to a third party, pays). MCP tools carry the server's
annotations in `metadata.annotations` (`@ai-sdk/mcp` copies only the hints the server sent).
Rules (normative, ADR-0025):

1. **App metadata wins.** A valid `metadata.risk` is the risk; it is trusted, so it may be lower
   than the hints suggest. `mcpServer({ risk })` (spec 09 §3) writes `metadata.risk` on its tools
   (trusted app input, same rank). Invalid risk values are ignored.
2. **Hints only tighten.** Without an app risk: `destructiveHint === true` → `'destructive'`; else
   `openWorldHint === true` → `'external'`. `readOnlyHint` and `idempotentHint` never derive or
   lower a risk. Only hints the server **sent** count — no MCP spec defaults are applied; a tool
   without risk or hints has no risk (`unknown` in `approval.risk`).
3. **One risk per tool**; derived precedence `destructive` > `external`. Policies that need both
   facts read `hints`.
4. **`idempotent`** comes only from app metadata (`metadata.idempotent: boolean`); `idempotentHint`
   is reported in `hints` only.
5. **Events carry traits.** `tool.approve` gets `risk?`, `idempotent?`, `hints?`; pending approvals
   and `ApprovalDecision` (§3.3) carry `risk?` and `idempotent?` (absent = unknown). Traits come
   from `toolCall.toolMetadata`, else from the current tool's `metadata` (`options.tools`): AI
   SDK's re-validation of approved calls passes the stored call without `toolMetadata`, and the
   traits must not fall back to `unknown` there (0.5.0 fix: before, `approval.risk.unknown:
   'denied'` denied user-approved calls at re-validation).

`approval.risk` maps a risk to a status; it is one more input of the most-restrictive
combination, so it can require approval or deny, but never loosen a stricter policy, hook or
grant. Pending approvals carry the tool input (after `tool.before` refinement, as the model call
recorded it), the risk and `idempotent`, so an inbox can show them from `state.core.pending` or
`TurnResult.pending` without loading messages.

Mapping back to MCP hints (documentation only; eharness exposes no MCP server, so no helper):
`read` ↔ `readOnlyHint: true`; `write` ↔ `readOnlyHint: false, destructiveHint: false,
openWorldHint: false`; `destructive` ↔ `destructiveHint: true`; `external` ↔ `openWorldHint: true`
(and `destructiveHint` as the tool requires).

`'external'` (0.5.0) is a **type-level** addition: exhaustive `switch` statements and
`Record<ToolRisk, …>` objects must add it. Behaviour of tools without the new hints or metadata
is unchanged.

### 3.3 Decisions (`approval.decided`)

Every decision is reported to `approval.decided` hooks (spec 01 §5) with an `ApprovalDecision`:
`{ toolName, toolCallId, input, risk?, idempotent?, approved, by, reason?, actor?, approvalId?, remember? }`.

- **Automatic** decisions, from the approval function when the combined status is `approved` or
  `denied` (not `user-approval`, not `not-applicable`): `by` is the source of the winning status —
  `'policy'`, `'risk'`, `'plugin:<name>'` or `'grant'`. Reported once per tool call (AI SDK calls
  the function again when it re-validates approved calls).
- **Answers** through `respond()`: `by: 'user'`, with the answer's `reason`, `remember` and
  `actor` — an `ApprovalActor { id: string; name?: string; …JSON }` the application passes to say
  who answered (with `handleChatRequest`: its `options.actor`, §7). The actor is never stored in
  messages nor sent to the model. Reported after the answers were consumed (the commit point), in
  answer order.
- **New input** while pending with `onNewInput: 'deny'`: `by: 'new-input'`, `approved: false`,
  `reason: DENIED_NEW_INPUT`.

Hook failures raise `W_HOOK_FAILED` and never change a decision. Together with `turn.end`
(`TurnResult.pending`) and session `pending` events, this is enough to build an approval inbox
across sessions: record requests from `pending`, resolve them with `respond()`, audit from
`approval.decided`. The core owns no inbox, no endpoint and no audit table.

## 4. `respond()`

```ts
respond(response: PendingResponse, options?: SendOptions): HarnessRun<M>

export interface PendingResponse {
  approvals?: Array<{ id: string; approved: boolean; reason?: string; remember?: 'once' | 'session'; actor?: ApprovalActor }>
  toolOutputs?: Array<{ toolCallId: string; output: unknown } | { toolCallId: string; errorText: string }>
}
```

Inside the run (same failure semantics as `send()`, spec 05 §2):

1. Lock, load, validate against `state.core.pending`:
   - every id must belong to the pending set, and **all** pending approvals and client tools must
     be answered in one call (v0 has no partial resolution) → else `EH_INVALID_INPUT`
     (`details.reason: 'unknown-id' | 'incomplete'`);
   - the pending message must still be the newest non-kind message of the view (nothing was sent
     after it) → else `EH_INVALID_INPUT` (`'stale'`). Stale answers never authorize anything.
2. **Consume**: clear `state.core.pending` and persist state before anything else (a replayed
   request finds nothing pending).
3. Patch the stored assistant message A: approval parts → `state: 'approval-responded'`,
   `approval: { ...part.approval, approved, reason }` (merge: keep `signature`,
   `inputSchemaInput`); client tool parts → `output-available` / `output-error` (outputs pass
   through `tool.after` and the output limits first, spec 09 §6);
   `metadata.eharness.pending = null`; `metadata.eharness.stop` is removed (the message is running
   again, so a crash during the continuation is recovered like any turn, spec 05 §9). Record
   grants (effective later, §3.1). Save A → A'. If anything after the consumption fails, the turn
   ends on A' (or A) and its answered calls are answered as interrupted (spec 05 §3). If the
   process dies between the consuming state write and the save of A', the next operation finds a
   message whose `metadata.eharness.pending` is set although `state.core.pending` does not name it
   and heals it at its commit point: open calls → `INTERRUPTED_CRASH`, `pending: null`,
   `stop: 'interrupted'` (same for the `onNewInput: 'deny'` patch).
4. **Continue the same message**: `createUIMessageStream({ originalMessages: [A'], … })`, `start`
   with `messageId: A.id` and no metadata (so `run.messageId` resolves to A's id and A's
   `createdAt`/`turnId` are kept), then one `tool-output-available` / `tool-output-error` chunk
   per client tool answer (headless readers see the outputs). The final `message-metadata`
   carries `pending: null` (or the new pending state) and usage/steps cumulative over both turns.
   The projected wire ends with a `tool` message holding the
   `tool-approval-response`s, so the first `streamText` call executes approved tools and emits
   denials (`execution-denied` with the reason) **before** calling the model. From there the
   turn runs normally (steps, stop rules, hooks).
5. **The first step of a continuation must end with that `tool` message.** AI SDK only collects
   approvals when the last prompt message has role `tool`. Therefore, for step 0 of a `respond`
   turn: no step reminder is appended (spec 02 §5), no `data-eh.input` is delivered (waiting
   input is delivered from step 1), and a `step.prepare` `messages` rewrite that does not end
   with that message is rejected (`W_HOOK_FAILED`, rewrite ignored).

A continuation turn must stream into the existing UI message: starting a fresh UI message fails in
AI SDK with `No tool invocation found for tool call ID`.

**Structured output (0.4.0).** `SendOptions.output` (spec 05 §3.3) is not part of the pending state
(a schema is not serializable): a turn that stopped `'tool-pending'` returns `output: undefined`,
and the continuation asks for a typed answer only when `respond(…, { output })` passes the spec
again. Its tool mode output tool is then appended for the continuation like for any turn.

### 4.1 New input while pending

`send()`, `regenerate()` and `edit()` check `state.core.pending` first:

- `onNewInput: 'deny'` (default): patch every pending approval part to `state: 'output-denied'`
  with `approval: { ...part.approval, approved: false, reason: DENIED_NEW_INPUT }`, every pending
  client tool part to `output-error` (`errorText: NOT_EXECUTED_NEW_INPUT`; texts in spec 10 §5),
  set `metadata.eharness.pending = null`, save A, clear pending (all at the commit point, spec 05
  §3 step 11), then continue with the new operation. The model sees the
  denials as tool results followed by the new message.
- `'reject'`: run error `EH_PENDING_RESPONSE`, nothing persisted.

## 5. Regenerate, edit, rewind

Stored history is append-only (spec 05). Hiding messages is done with a core kind:

| Kind | Role | Boundary | Model | Payload |
|---|---|---|---|---|
| `eh.rewind` | user | no | omit | `{ afterId: string \| null; reason: 'regenerate' \| 'edit' \| 'revert' }` |

**View rule:** a rewind R hides every message `m` with `afterId < m.id < R.id`, except boundary
markers (compaction) and other rewinds. Hidden messages are excluded from projection, compaction
input and `session.messages()` (unless `messages({ includeHidden: true })`). The core mirrors
active rewinds in `state.core.rewinds: Array<{ afterId: string | null; rewindId: string }>` for
cheap filtering; the kind messages are the source of truth (the loader heals state from them).

Constraint: `afterId` must be inside the current view (≥ the newest boundary's `resumeFromId`),
otherwise `EH_INVALID_INPUT` (`'beyond-compaction'`). Content summarized by a mid-turn compaction
of a now-hidden message may remain in the summary — documented limitation.

Rewinds never roll back plugin state (`ctx.state`) or external side effects (files, APIs).

```ts
/** Answer again. Default target: the newest assistant message in the view. */
regenerate(opts?: { messageId?: string } & SendOptions): HarnessRun<M>
/** Replace a stored user message (matched by id or metadata.eharness.clientId) and answer it. */
edit(messageId: string, input: SendInput, options?: SendOptions): HarnessRun<M>
```

- `regenerate`: target assistant message A (by id or client id). Save
  `eh.rewind { afterId: <id of the message just before A>, reason: 'regenerate' }`, then run a
  no-input turn. The current turn (spec 06 §5.1) is the turn of the re-answered user message.
- `edit`: target user message U. Save `eh.rewind { afterId: <id just before U>, reason: 'edit' }`,
  then a normal `send(input)` (new server id; the client id of U — or U's id when U has none — is
  copied to `metadata.eharness.clientId` of the new message so the UI can reconcile; editing that
  id again therefore targets the replacement). `input.submit` runs with `via: 'edit'`.
- "The message just before" is the previous message of the current view (kind messages count,
  compaction markers do not); `afterId: null` when the target is the first message of an
  uncompacted session.
- A target that is not in the current view (unknown id, hidden, or not of the expected role) →
  `EH_INVALID_INPUT` (`'not-found'`).
- Both run through §4.1 first when pending.

## 6. Steering, queueing, background wake-up

```ts
export interface SendOptions {
  /**
   * When a turn is running: 'reject' (default, EH_SESSION_BUSY thrown), 'queue', 'steer' or
   * 'collect' (send() only; 'collect': merged with other collected inputs into one queued turn,
   * spec 05 §12 rule 6), or 'wait' (send() and respond(), §6.2).
   */
  ifBusy?: 'reject' | 'queue' | 'steer' | 'wait' | 'collect'
  // … other fields in spec 05 §2
}
```

`respond`, `regenerate` and `edit` always reject while a turn runs (they depend on the state the
running turn is still changing).

### 6.1 Steer

The input is normalized and passed through `input.submit` (`via: 'steer'`) immediately — a
`block` drops only this input (an `input-dropped` event with `reason: 'blocked'`; the running turn
continues) — then delivered to the running turn **at the next step boundary** (after the current
step's tool results, before the next model call):

- The core writes a persistent core data part into the running assistant message:
  `data-eh.input { source: 'user', text, files?, clientId? }`.
- The same content is appended to the wire as a `user` model message.
- The loop continues even if the step would otherwise stop with `'complete'` (new input deserves
  an answer).
- Several steers queued before one boundary are delivered together, in order.
- If the turn stops before delivery:
  - `'tool-pending'` or `'aborted'` → the input is **not** used (it would otherwise auto-deny the
    approvals the user is looking at, or override the abort); the core emits
    `{ type: 'input-dropped', reason: 'tool-pending' | 'aborted', text, clientId? }` on
    `events()` so the UI can put the text back into the input box;
  - any other stop → the input becomes a queued `send` turn (§6.2), announced by `turn-start`
    with `queued: true`.
- `send(…, { ifBusy: 'steer' })` returns `session.attach()` of the running turn. If the session
  is idle, it behaves like a normal `send()`.
- The delivered `text` is the input's text parts followed by `input.submit` `context` strings,
  joined with a blank line; `files` are its file parts.
- A steer that arrives when the running turn no longer takes input (its step loop ended), a steer
  without input, and a steer while a manual `compact()` runs become queued `send` turns (§6.2,
  `input.submit` with `via: 'queue'`). Invalid steer input (normalization, spec 05 §3) is a run
  error of a separate failed run (`EH_INVALID_INPUT`), never thrown; the running turn is not
  affected.
- At a boundary, steers and `next-step` injections are delivered first (arrival order), then hook
  context (§6.4). No input is delivered before the first step of a `respond()` continuation.

**Projection** (spec 03 §6) splits an assistant message at each `data-eh.input` part into
`assistant(before) → user(text, files) → assistant(after)`. Because the part sits exactly where
the model saw it, stored order equals model order and reloads project identically.

### 6.2 Queue

`ifBusy: 'queue'` normalizes the input (invalid input → a failed run, `EH_INVALID_INPUT`), keeps
it in an in-memory FIFO per live session and returns a `HarnessRun` whose `turnId` is fixed now and
whose stream starts when that turn starts (`run.messageId` resolves then; `input.submit` runs then,
with `via: 'queue'`). `run.abort()` of a queued run that has not started removes and drops only
that run.

**Held while pending.** The queue does not start a turn while `state.core.pending` is set: a queued
turn (send or wake) never applies `onNewInput` to approvals the user has not answered. It starts
once the pending state is resolved — by `respond()`, or by an explicit new `send()` /
`regenerate()` / `edit()` (which applies `onNewInput`). A continuation that ends `tool-pending`
again keeps the queue held. A held queue does not keep the session alive: idle eviction (spec 05
§1) closes it and drops the held runs (`stop: 'aborted'`, like `close()`). A dropped wake turn loses
nothing: its kind message is stored and reaches the model at the next turn. Queued turns are ordinary `send` turns
(`TurnInfo.queued = true`) and run in order after the current turn ends. `abort()` and `close()`
drop the queue (dropped runs resolve with `stop: 'aborted'`, spec 05 §2). A cross-process abort
(spec 05 §9.1) drops the queue of **both** instances: the requester's (`abort()` /
`requestAbort()` drop it first) and the owner's (its turn ends `'aborted'`, which drops the queue
like a local abort; its waiting steers become `input-dropped`). The in-memory queue is per
process and lost on restart (a `SessionLock` rejection, or a turn running in another instance,
is a run error of `send()`). **Cross-instance queuing** (0.4.0) goes through
`session.enqueue(input, { mode: 'queue' | 'steer' | 'collect' })` and an optional durable
`storage.inbox` (spec 05 §12): the input is stored, and the instance that holds the session —
the one running its turn, or any free live instance when none runs — applies it in id order: a
steer at the next step boundary of the running turn, a queued input or a collect burst as the
next turn. Items survive restarts (at-least-once with dedupe). `abort()` never drops them.

**`ifBusy: 'wait'`** (`send()` and `respond()`) joins the same FIFO, with three differences: the
waiting caller is not dropped by `session.abort()` (it aborts only the running turn and the
plain queue; `close()` and the caller's own `abortSignal` drop it, `stop: 'aborted'`, nothing
persisted); a waiting `respond()` may start while the queue is held by pending approvals (that
is what resolves them); and a waiting `send()` is held only by pending approvals that did not
exist when it was called — approvals created by a turn it waited for are never denied by it —
while approvals already pending at call time are handled as by a new `send()` (`onNewInput`).
The queue stays FIFO: a waiting `send()` starts only from the head, so it never overtakes a
queued turn ahead of it (if that one is held by pending approvals, the waiting `send()` waits
too). Only a waiting `respond()` may start from any position while the queue is held.
`session.idle()` resolves when no turn runs and nothing is queued.

### 6.3 `inject()` delivery and wake

```ts
inject<K extends KindName<Kinds>>(kind: K, data: KindData<Kinds, K>, opts?: {
  /** 'next-turn' (default) or 'next-step' (delivered into the running turn like a steer). */
  deliver?: 'next-turn' | 'next-step'
  /** If idle, start a no-input turn now; if running, implies deliver: 'next-step'. */
  wake?: boolean
}): Promise<{ message: M; run?: HarnessRun<M> }>
```

- The kind message is always saved as its own message (history, UIs).
- With `next-step` delivery during a turn, its model projection is also written into the running
  message as `data-eh.input { source: 'event' }`. **After** the snapshot containing that part is
  saved, the kind message is updated with `metadata.eharness.deliveredIn = <assistant id>`;
  projection skips kind messages that have `deliveredIn`. A crash between the two saves delivers
  the event twice (at-least-once), never zero times. Without `persistEachStep` the update happens
  after the final save.
- A `next-step` injection that arrives while the turn is still preparing (before step 0) goes to
  the turn's inbox like any other: it is delivered once at step 0 as `data-eh.input` and is not
  also projected as a standalone message of that turn, even when its id sorts before the turn's
  user message — so the stored order projects exactly like the wire the model saw (ADR-0011).
- `wake` from the process that runs (or can run) the session works as described here. **Another
  process** (0.4.0): with `storage.inbox`, when a turn of the session runs in another instance,
  `inject(…, { wake: true })` saves the kind message, enqueues a `wake` item and notifies the
  holder (no `run` is returned); the holder runs a no-input wake turn after its running turn
  (spec 05 §12). Without an inbox, the turn starts in the calling process as soon as the session
  is free there (a live foreign turn makes it a run error `EH_SESSION_BUSY`).
- The delivered text is the kind's model projection (spec 03 §5.1), text parts joined with a blank
  line. A kind that is not projected (`'omit'`, `null`), a projection with file parts, or a
  projection that throws (`W_HOOK_FAILED`) is not delivered inline: the message stays a plain
  saved message without `deliveredIn` and reaches the model (whole) at the next turn.
- An injection that was not delivered before the turn stopped stays undelivered (no
  `deliveredIn`) and reaches the model at the next turn.
- **`wake` is never lost.** When it cannot be delivered inline — the running turn no longer takes
  input (it is ending), a manual `compact()` runs, the event is not deliverable inline, or it was
  still waiting when the turn stopped (any stop but `aborted` / `timeout`) — a no-input `wake`
  turn is queued (§6.2) and runs when the session is free; `inject()` returns its `run` when it
  queued it. While `state.core.pending` is set the queue is held (§6.2), so a background event
  never denies approvals the user is looking at (§4.1): the wake turn runs after `respond()`.

### 6.4 Hook-provided context

`step.end` returning `{ context }` and `turn.beforeEnd` returning `{ continue: { reason } }`
(spec 01 §5) are delivered the same way: `data-eh.input { source: 'plugin:<name>', text }` at the
step boundary.

## 7. `handleChatRequest` (useChat adapter)

```ts
export interface ChatRequestBody {
  messages: UIMessage[]
  trigger?: 'submit-message' | 'regenerate-message'
  messageId?: string
}
export interface ChatRequestOptions extends SendOptions {
  /** The request's user: set on every approval answer of the respond() path (approval.decided). */
  actor?: ApprovalActor
}
export function handleChatRequest<M extends UIMessage, Kinds extends Record<string, unknown>>(
  session: HarnessSession<M, Kinds>,
  body: ChatRequestBody,
  options?: ChatRequestOptions,
): HarnessRun<M>
```

Dispatch is **synchronous and uses only the request body** (the server never trusts client
history; only decision fields are read; everything that needs stored data is checked inside the
run and reported as a run error):

1. `trigger === 'regenerate-message'` → `regenerate({ messageId: body.messageId })`.
2. last message has `role: 'assistant'` → `respond(extractResponses(last))`: reads only
   `approval.id / approved / reason` of parts in `approval-responded`, and `toolCallId` /
   `output` / `errorText` of tool parts in `output-available` / `output-error`. Inside the run
   the answers are matched against `state.core.pending`; entries that are not pending are ignored,
   and a pending item without an answer → `EH_INVALID_INPUT` (`'incomplete'`).
3. `body.messageId` is set (useChat sends it when a message is replaced) and the last message has
   `role: 'user'` → `edit(body.messageId, last)`.
4. otherwise → `send(last, options)` (a body without messages → run error `EH_INVALID_INPUT`).

`options` are passed to every operation (e.g. `{ ifBusy: 'steer' }` makes a request that arrives
while a turn runs steer it; `{ ifBusy: 'wait' }` makes `send` and `respond` wait for it).
`options.actor` (0.4.0, the authenticated user of the request) is set on every approval answer of
the `respond()` path, so `approval.decided` receives it (§3.3); the client cannot set it.

**Busy sessions.** `handleChatRequest` never throws `EH_SESSION_BUSY` (it still throws
`EH_SESSION_CLOSED`). When the operation is rejected as busy — `regenerate` / `edit` while a turn
runs, `send` / `respond` without a waiting `ifBusy` — it returns a failed run (`stop: 'error'`,
`error.code: 'EH_SESSION_BUSY'`, type `HarnessRun`) whose `toResponse()` / `pipeTo()` answer
**409** with the JSON body `{ error: { code, message } }` instead of a UI message stream. Since
the stream of a turn ends only after the turn finalized (spec 05 §3 step 17), a client that waits
for the end of a response before sending the next request never sees a 409 from its own turn
(a queued, waiting or wake turn that started after it, or another tab's request, still can).

Typical route:

```ts
export async function POST(req: Request) {
  const body = await req.json()                      // { id, messages, trigger, messageId }
  const session = agent.session(body.id, { runtime: { userId } })
  // busy: 409 { error: { code: 'EH_SESSION_BUSY', … } } — or pass { ifBusy: 'wait' } to wait
  return handleChatRequest(session, body).toResponse()
}
```

Client setup: `useChat({ sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses })`
(or `…WithToolCalls` for client tools).

Resume caveat: `useChat` rebuilds a resumed message only from replayed chunks. `attach()` of a
continuation turn (after `respond()`) replays only the continuation, so a client that resumes it
should re-fetch that message (`session.messages()`) when the turn ends. Full replay of the stored
prefix is roadmap.

## 8. Security rules (normative)

- Pending ids are server-owned (`state.core.pending`) and **consumed atomically** before a
  continuation runs; replays and stale answers never execute tools.
- Clients can never add tool parts, data parts or kinds (spec 05 §3 input normalization).
- `approval.secret` adds HMAC signatures (defence in depth when storage is shared or exposed).
- The reviewer's identity/authorization is the application's job (check it before calling
  `respond()`).
