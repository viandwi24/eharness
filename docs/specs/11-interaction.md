# Spec 11 — Interaction: approvals, client tools, regenerate/edit, steering, wake

Status: **Accepted** (v0). Modules: `src/session/interaction/*`, `src/stream/chat-request.ts`.

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
| `abort(reason)` | stop the running turn | — |

`handleChatRequest()` (§7) maps a `useChat` request body onto these operations.

## 2. Pending state

A turn that ends with `stop: 'tool-pending'` leaves the session **pending**:

```ts
export interface PendingState {
  messageId: string                                   // the assistant message waiting for answers
  approvals: Array<{ approvalId: string; toolCallId: string; toolName: string }>
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
it re-verifies the signature (`approval.secret`), re-runs `experimental_refineToolInput` and
requires the result to deep-equal the stored input, and calls `toolApproval` again (a `denied`
now denies the call). Consequences, normative for eharness:

- `tool.before` hooks must be **idempotent** (applied to their own output they return it
  unchanged); otherwise every approved call is rejected as invalid input.
- The approval function (below) runs a second time for approved calls; policies and
  `tool.approve` hooks must be deterministic and side-effect free.
- Stored approval objects are patched by merging, never replaced (`signature` and
  `inputSchemaInput` must survive, §4).

```ts
defineHarnessAgent({
  approval?: {
    /** Static policy; same shape as AI SDK ToolApprovalConfiguration (per-tool map or generic function). */
    policy?: ToolApprovalConfiguration<ToolSet, unknown>
    /** Passed as experimental_toolApprovalSecret: HMAC-signs requests; responses are verified. */
    secret?: string
    /** What send()/regenerate()/edit() do while approvals are pending. Default 'deny'. */
    onNewInput?: 'deny' | 'reject'
  },
})
```

Per step the core builds **one** `GenericToolApprovalFunction` and passes it as `toolApproval`:

1. `approval.policy` result (per-tool entry or generic function);
2. every `tool.approve` hook (spec 01 §5), in plugin order;
3. session grants (§3.1).

Results are normalized to `{ type, reason? }` and combined **most restrictive wins**:
`denied` > `user-approval` > `approved` > `not-applicable`. A hook that throws counts as
`denied` (fail closed). The approval function sees the input **after** `tool.before` refinement
(AI SDK runs `experimental_refineToolInput` before approval).

### 3.1 Grants

`respond({ approvals: [{ id, approved, remember: 'session' }] })` stores
`state.core.grants[toolName] = 'always' | 'never'`. At step 3 above: `never` → `denied`;
`always` turns a `user-approval` into `approved` but never overrides `denied`. Grants are
per session, cleared by `session.clearGrants()`, and take effect **after the first step of the
continuation** (so AI SDK's re-validation of the calls just answered is not affected by them).
A grant that can never apply (the policy or a hook returns `denied` for that tool) raises
`W_GRANT_IGNORED` once.

## 4. `respond()`

```ts
respond(response: PendingResponse, options?: SendOptions): HarnessRun<M>

export interface PendingResponse {
  approvals?: Array<{ id: string; approved: boolean; reason?: string; remember?: 'once' | 'session' }>
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
   `inputSchemaInput`); client tool parts → `output-available` / `output-error`;
   `metadata.eharness.pending = null`. Record grants (effective later, §3.1). Save A → A'.
4. **Continue the same message**: `createUIMessageStream({ originalMessages: [A'], … })`, `start`
   with `messageId: A.id` and no metadata (so `run.messageId` resolves to A's id and A's
   `createdAt`/`turnId` are kept). The projected wire ends with a `tool` message holding the
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
  then a normal `send(input)` (new server id; the client id of U is copied to
  `metadata.eharness.clientId` of the new message so the UI can reconcile).
- A target that is not in the current view (unknown id, hidden, or not of the expected role) →
  `EH_INVALID_INPUT` (`'not-found'`).
- Both run through §4.1 first when pending.

## 6. Steering, queueing, background wake-up

```ts
export interface SendOptions {
  /** send() only. When a turn is running: 'reject' (default, EH_SESSION_BUSY thrown), 'queue', or 'steer'. */
  ifBusy?: 'reject' | 'queue' | 'steer'
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

**Projection** (spec 03 §6) splits an assistant message at each `data-eh.input` part into
`assistant(before) → user(text, files) → assistant(after)`. Because the part sits exactly where
the model saw it, stored order equals model order and reloads project identically.

### 6.2 Queue

`ifBusy: 'queue'` normalizes the input, keeps it in an in-memory FIFO per live session and
returns a `HarnessRun` whose stream starts when that turn starts (`run.messageId` resolves then;
`input.submit` runs then, with `via: 'queue'`). Queued turns are ordinary `send` turns
(`TurnInfo.queued = true`) and run in order after the current turn ends. `abort()` and `close()`
drop the queue (dropped runs resolve with `stop: 'aborted'`, spec 05 §2). The queue is per process
and lost on restart; cross-instance queuing is the application's job (a `SessionLock` rejection
is a run error).

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
- `wake` requires the session to be live in this process. Cross-process wake-ups are done by the
  application calling `agent.session(id).inject(…, { wake: true })` in the right process.

### 6.4 Hook-provided context

`step.end` returning `{ context }` and `turn.beforeEnd` returning `{ continue: { reason } }`
(spec 01 §5) are delivered the same way: `data-eh.input { source: 'plugin:<name>', text }` at the
step boundary.

## 7. `handleChatRequest` (useChat adapter)

```ts
export function handleChatRequest<M extends HarnessUIMessage>(
  session: HarnessSession<M>,
  body: { messages: UIMessage[]; trigger?: 'submit-message' | 'regenerate-message'; messageId?: string },
  options?: SendOptions,
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
4. otherwise → `send(last, options)`.

Typical route:

```ts
export async function POST(req: Request) {
  const body = await req.json()                      // { id, messages, trigger, messageId }
  const session = agent.session(body.id, { runtime: { userId } })
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
