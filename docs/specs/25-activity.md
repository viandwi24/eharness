# Spec 25 — Activity feed and attention queue (`eharness/activity`)

Status: **Draft (0.8)**. Module: `src/activity/*`. Built only with the public core API (ADR-0008).
Decision record: ADR-0058. Lifted from the team example, which built both by hand.

Two things every harness app rebuilds: a **feed** of what happens in sessions (so UIs update live,
across instances) and an **attention queue** (everything that waits for a person, across a parent
and its children, and a safe way to answer it).

```ts
import {
  activity, memoryActivityStore, handleActivityStream, activityStream, readActivityPage,
  listAttention, answerAttention,
} from 'eharness/activity'
```

## 1. Records and the store port

```ts
interface ActivityInput  { type: string; sessionId?: string | null; agentId?: string | null; payload?: Record<string, unknown>; at?: number }
interface ActivityRecord { seq: number; type: string; sessionId: string | null; agentId: string | null; payload: Record<string, unknown>; createdAt: number }
```

`type` is free-form. The library's events (§2) and an app's own events (`providers-changed`,
`settings-changed`, …) share one feed and one `seq`; an app must not reuse a library type with
another payload. `boot` and `resync` are reserved SSE event names (§4).

## 2. The `activity()` plugin

`activity({ store, agentOf?, sessions?, types?, messages?, now? })` registers hooks and appends to
`store`, on whichever instance runs the turn. An append never breaks a turn (failure: `ctx.log.warn`).
`agentOf` maps the agent id of the context (the catalog slug) to the id the feed carries;
`sessions(id, ctx)` keeps internal sessions out; `types` narrows the events; `messages: false`
turns `message-saved` off.

Every event has `sessionId` and `agentId`. Payloads (`SessionActivityPayloads`):

| type | when | payload |
|---|---|---|
| `turn-started` | `turn.start` | `turnId`, `kind` (`send` `respond` `regenerate` `edit` `wake`), `source` (`user` `event` `wake` `respond` `regenerate`), `queued`, `parentSessionId?`. `source: 'event'` = a send that came from the inbox (`enqueue`). |
| `step-finished` | `step.end` | `turnId`, `stepIndex`, `finishReason`, `usage {inputTokens, outputTokens, totalTokens}`, `costUsd?`, `toolCalls: string[]` |
| `turn-ended` | `turn.end` | `turnId`, `kind`, `stop`, `messageId?`, `steps`, `durationMs`, `usage`, `costUsd?`, `partial?`, `error?`, `parentSessionId?` |
| `pending-changed` | `turn.end` with `tool-pending`, and the end of a `respond`/`regenerate`/`edit` turn | `turnId`, `messageId?`, `waiting: PendingRef[]` (a snapshot: items that wait now; empty = nothing waits), `answered: PendingRef[]` (answered by a partial `respond()`, waiting for the rest of the batch). `PendingRef = { kind: 'approval' \| 'client-tool' \| 'wait', id, toolCallId, toolName }` with `id` = `approvalId`, `toolCallId`, `waitId`. |
| `approval-decided` | `approval.decided`, for answers of people and every denial (automatic approvals are skipped) | `toolName`, `toolCallId`, `approved`, `by`, `id?` (the approval id), `actor?`, `reason?` |
| `message-saved` | `message.saved` (core hook, after `MessageAdapter.save`), once per message id per save | `messageId`, `role`, `kind?`, `stop?`, `turnId?` |
| `child-reported` | the **child's** `turn.end` when it does not stop on `tool-pending`; emitted on the **parent** session | `childSessionId`, `status` (`completed` `failed` `stopped`, else the stop), `stop`, `toolCallId?`, `messageId?` |
| `session-recovered` | a saved `eh.notice` with code `EH_TURN_INTERRUPTED` (recovery repaired a dead turn) | `turnId?`, `messageId`, `reason: 'interrupted'` |
| `compaction` | `compaction.after` | `markerId`, `trigger?`, `tokens?` |
| `attention-answered` | `answerAttention()` (§5), when given a `store` | `id`, `kind`, `status`, `remaining?`, `approved?`, `actor?` |

The partial-answer, external-wait and client-tool answers that do not run a turn (`recorded`) are
visible through `attention-answered` and the next `pending-changed`.

`SESSION_ACTIVITY_TYPES` lists the library's types.

### 2.1 Core hook `message.saved`

`'message.saved'?(ctx, messages: HarnessUIMessage[])` (spec 01 §5): observe-only, awaited in plugin
order after `MessageAdapter.save` succeeded, with copies of the stored messages (an upserted
assistant message repeats). Errors are `W_HOOK_FAILED`. It exists so a feed never announces a
message a reader cannot load yet (`message.beforeSave` runs before the save).

## 3. `ActivityStore`

```ts
interface ActivityStore {
  append(events: ActivityInput | readonly ActivityInput[]): Promise<ActivityRecord[]>
  read(q: { after: number; limit: number; types?: readonly string[]; sessionId?: string }): Promise<ActivityRecord[]>
  lastSeq(): Promise<number>
  prunedThrough(): Promise<number>
  prune(o: { olderThan?: number; keepLast?: number; keepLatestOf?: { type: string; by: 'agentId' | 'sessionId' }[] }): Promise<{ deleted: number; prunedThrough: number }>
}
```

Contract, checked by `activityStoreConformance` (`eharness/testing`):

1. `seq` strictly increases across all appenders (also concurrent ones in several instances), within
   a batch too, starts at 1 and is **never reused**, also after pruning.
2. `read` returns copies after a cursor, oldest first, `limit` applied after the filters. A cursor
   beyond the head reads nothing.
3. `prune` removes a **prefix of the log**: the boundary is the highest `seq` that is older than
   `olderThan` or beyond the newest `keepLast`; everything up to it goes, except the survivors of
   `keepLatestOf` (the newest record of a type per `agentId`/`sessionId`, e.g. the last
   `message-added` of every agent for a sidebar preview). The **newest record is never removed**
   (it is the head cursors compare to). `prunedThrough` becomes the boundary and **never goes
   down**. A prune that removes nothing leaves it alone.
4. Multi-instance: each instance appends; readers tail by `seq`; both see one log.

`memoryActivityStore({ now? })` is the shipped adapter; `pruneBoundary(records, options)` is the
retention rule for adapters that keep records themselves. Database adapters are examples (rule 5).

## 4. SSE

Web APIs only (`ReadableStream`, `Request`, `Response`).

- `activityCursor(request)` reads the cursor of a request (`?after=` wins over `Last-Event-ID`): a number, `undefined` when none, `null` when invalid. Shared with `eharness/http`; use it in a custom SSE route.
- `encodeActivityEvent(record)`: `id: <seq>\nevent: <type>\ndata: <record JSON>\n\n`.
- `activityStream({ store, after?, filter?, bootId?, pollMs = 500, keepAliveMs = 8000, retryMs = 3000, batch = 200, signal?, onError? })`
  → `ReadableStream<Uint8Array>`. Frames:
  1. At once, before the first store read: `retry: <ms>`, a `: connected` comment and, with
     `bootId`, `event: boot` with `{"boot": "<id>"}` (a changed id tells the client the server restarted).
  2. `after` given and `0 < after < prunedThrough`, or `after > lastSeq` (the log was reset): one
     `event: resync` with `{"seq": <the mark, or the head>}`, then the stream continues from there:
     the client refetches its state. `after === 0` never resyncs.
  3. Records after the cursor, in `seq` order (`filter` hides some; the cursor still advances).
  4. `: keep-alive` after `keepAliveMs` of silence. The default stays below the 10 s idle timeout of
     `Bun.serve` and of common proxies, which close a quiet connection.
  The tail honours backpressure: while the client's queue (512 frames) is full the store is not read; a client that stops reading holds nothing in memory beyond that.
  Without `after` the stream starts at the current head (new events only). It ends on `signal` abort,
  on `cancel()` and on a store error (`onError`).
- `handleActivityStream(request, options)`: `Response` (`text/event-stream`, `no-cache, no-transform`,
  `x-accel-buffering: no`). The cursor is `?after=` or else the `Last-Event-ID` header; an invalid one
  is `400`. The stream ends when the request aborts. Authenticate before calling it.
- `readActivityPage(store, { after, limit, filter? })` → `{ events, lastSeq, resync? }`: the JSON
  twin for polling clients (`lastSeq` = the last returned `seq`, else the head, never below `after`).

## 5. The attention queue

Reads use `SessionPeek` (no hooks, no resume, no lock): they work on any instance and never wake a
parked parent.

```ts
listAttention({ roots, peek, waits?, maxDepth? }): Promise<AttentionItem[]>
```

`roots`: session ids (or `{ sessionId, agent? }`); children are walked recursively through the
child index (`peek.children()`), `maxDepth` default 8. `peek(sessionId, { agent?, parentSessionId })`
returns the read handle of the agent that runs that session (the child index carries the catalog
key as `agent`). Items:

```ts
interface AttentionItem {
  id: string                      // approvalId | toolCallId | waitId; unique within sessionId
  kind: 'approval' | 'client-tool' | 'wait'
  sessionId: string               // the owner: answer THERE
  parentSessionId: string | null; rootSessionId: string
  agent?: string; name?: string; description?: string
  toolCallId: string; toolName: string; input: unknown; risk: ToolRisk | null
  messageId: string; createdAt: number | null   // time of the assistant message (UUIDv7)
  waitId?; payload?; correlationId?; timeoutAt?
  answeredWaiting: number         // items of the session answered by a partial respond(), hidden
}
```

Answered items (partial `respond()`, recorded results) are not listed. External waits are listed
only with `waits: true` (or a predicate): a parent parked on a subagent is an external wait nobody
can answer.

```ts
answerAttention(id, { sessionId, answer, open, peek, actor?, store?, agentId?, sendOptions?, settleMs?, busyChecks? }): Promise<AnswerAttentionResult>
type AttentionAnswer =
  | { kind: 'approval'; approved; reason?; note?; remember?; endTurn? }
  | { kind: 'client-tool'; output } | { kind: 'client-tool'; errorText }
  | { kind: 'wait'; output } | { kind: 'wait'; errorText }
```

`open(sessionId)` gives the live session of the agent that runs it; `answerAttention` calls
`respond()` (approval, client tool) or `resolveWait()` (wait) **on that session, never through the
parent**: a child's answer continues the child, and when its turn ends the subagent plugin resolves
the parent's wait in whichever instance holds it. Result `{ status, id, sessionId, kind?, remaining?, done? }`:

| status | meaning |
|---|---|
| `resumed` | the answer completed the batch; the session continues. `done` settles with the continuation's `TurnResult` (never rejects). |
| `recorded` | stored; `remaining` items of the batch still wait, nothing ran (ADR-0044). |
| `already-answered` | the item was answered before (this tab, another tab, another instance, the classifier): nothing was done. Also returned for a repeated answer. |
| `not-found` | the id is not pending and not in the recent history of the session. |

Mapping (the single place this logic lives): item not pending but present in the last 40 messages →
`already-answered`, absent → `not-found`; item already holding a recorded answer →
`already-answered`; `respond` rejected with reason `unknown-id`, `stale` or `conflict`, or
`EH_SESSION_BUSY` while the item is gone after a short re-check (the same item is being answered
right now) → `already-answered`; a partial answer or a run still going with items left →
`recorded`. Errors that remain exceptions: a wrong answer kind or an invalid answer
(`EH_INVALID_INPUT`, `details.reason: 'wrong-kind'` or the session's own), `EH_SESSION_BUSY` while
the item still waits (another turn of the session runs), `EH_SESSION_CLOSED`, storage errors, and a
run that fails for another `EH_*` reason (thrown as that `HarnessError`).

Idempotent: repeating an answer never changes what was decided and never runs anything twice. Safe
from any instance. With `store`, an `attention-answered` event is appended for every call.

## 6. Out of scope

Database adapters (examples), authentication and routing of the HTTP layer, mapping ask questions
to tool outputs (`eharness/ask`'s `answerOutput`; the result goes into `{ kind: 'client-tool', output }`),
read markers and unread counts (app domain).
