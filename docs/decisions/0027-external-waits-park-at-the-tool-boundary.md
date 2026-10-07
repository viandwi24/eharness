# ADR-0027: External waits: park at the tool boundary

Status: **Proposed** · Date: 2026-10-06 · Amends: ADR-0012, ADR-0014

## Context

Some tools cannot answer inside a turn: a CI build, a human review, a webhook, another agent. The
result arrives minutes or days later, in any process. Prior art converges on the same shape
(LangGraph `interrupt`, OpenAI Agents `RunState` interruptions, Pydantic AI deferred tools,
Mastra suspend/resume, Inngest `waitForEvent`): the run stops, nothing is held, and a later call
supplies the result. ADR-0012 already parks a turn on approvals and client tool calls and
continues the **same** assistant message; ADR-0014 says a call is answered, never re-executed.
AI SDK has no generic park/resume helper (verified against v7: a tool without `execute` ends the
generation with the call unanswered; `tool.metadata` is never sent to the model).

## Decision

- **Snapshot at the tool boundary, not replay.** An external wait is an AI SDK tool **without
  `execute`** (`externalTool()`), exactly like a client tool. No chunk is rewritten (chunk order is
  public API). A marker returned from `execute` was rejected: AI SDK would record it as a real
  output (`tool-output-available`) and the core would have to suppress and rewrite chunks.
  The tool is a plain `tool()`; the harness-side definition (`start`, timeouts) rides on a symbol
  property that survives spreads.
- **A new pending kind, `externals`.** `PendingState.externals[]` holds `waitId` (`w_<toolCallId>`,
  stable), correlation id, payload, `timeoutAt`, an explicit `onTimeout` result and the recorded
  `result`. External calls are not `clientTools`: a browser can never resolve them
  (`handleChatRequest` ignores such answers; `respond({ toolOutputs })` is `'wrong-kind'`).
- **`start` runs after the commit** (amended in 0.5.0 review), in tool-call order, inside the
  turn (`ctx.turn` is live). Running it before the commit lost fast callbacks: a `resolveWait()`
  arriving from `start` found nothing pending. The entry carries `started: false` / `parkedAt`
  until `start` was dispatched; its outcome (correlation id, payload, timeout overrides) is then
  stored with a CAS. A throwing `start` is `W_HOOK_FAILED` and the wait stays parked until its
  timeout (it no longer answers the call: the call is already committed as pending). A crash
  before the commit is the existing stale-turn recovery (`INTERRUPTED_CRASH`); a crash between the
  commit and `start` leaves `started: false` and the start is dispatched again, idempotently by
  `waitId`, when a session opens or `expireWaits()` runs after `recovery.staleMs`.
- **Recording is separate from continuing.** `resolveWait()` validates against `outputSchema`,
  passes the result through `tool.after` and the output limits, and records it in
  `state.core.pending` with a compare-and-set (`setIf`; under the session lock when the adapter
  has none). The first result wins; the same wait again is `already-resolved`; a timeout racing a
  result is whichever CAS commits first. Nothing runs in memory before the CAS, so any instance
  can record. When nothing is unresolved, the continuation is the `respond()` path with an empty
  response: it consumes the pending state atomically (ADR-0012) and streams into the same message.
  Recorded results are used as recorded; they are never answered twice.
- **Timeouts have three paths, one result.** A timer in the holding process; a durable
  `wait-timeout` inbox item enqueued after the pending state was stored, with
  `availableAt: timeoutAt` (ADR-0026 timers), applied by whichever instance drains it, never held
  by pending (like aborts) and acked when the wait is already resolved; `session.expireWaits()`
  for cron sweepers without an inbox. All record `onTimeout` (default `WAIT_TIMED_OUT`) through
  the same CAS, so a wait resolves exactly once. `expireWaits()` also continues a pending state
  whose waits are all recorded (an instance died between recording and continuing).
- **New input** (`onNewInput: 'deny'`) answers open waits with `WAIT_CANCELLED_NEW_INPUT` and keeps
  results already recorded; a late result is `not-pending`.
- **Versioned pending.** `PendingState.v = 2` is written by 0.5; no `v` is the 0.3 / 0.4 shape and
  reads as before; an unknown `v` authorizes nothing (`resolveWait` → `not-pending`, `respond()` →
  `EH_INVALID_INPUT` `'stale'`). Goldens that include pending state change once, for `v`.
- **The app authenticates the caller.** The core cannot verify a webhook; the application checks
  the signature or correlation id before calling `resolveWait()`.

## Consequences

- Public additions: `externalTool()`, `session.resolveWait()` / `expireWaits()` / `pendingWaits()`,
  `respond({ externals })`, `InboxItemInput` kind `wait-timeout`, `SessionEvent` `wait-resolved`,
  `PendingState.v` / `externals`, `clientTools[].timeoutAt` / `onTimeout` (reserved for P24),
  fixed texts `WAIT_TIMED_OUT` / `WAIT_CANCELLED_NEW_INPUT`, `EH_INVALID_INPUT` reasons
  `'wrong-kind'` / `'invalid-result'`. Exhaustive switches over `InboxItemInput` / `SessionEvent`
  need the new members.
- A recording needs the pending message's tool (for `outputSchema` and `tool.after` input): static
  and plugin tools are found at once; tool-source tools are listed on demand.
- In-process timers are capped at `setTimeout`'s 2^31-1 ms; longer waits rely on the inbox item or
  `expireWaits()`.
- Approval and external tools compose (patch): an `approved` status of a tool without `execute`
  (policy, risk, hook, grant) is "no human needed" and parks the wait as without a policy; only
  `user-approval` creates an approval entry, and after the human approved, the call parks its wait
  (commit, then `start`) like an approved client call. Approved server calls of the same batch stay
  in `approvals` with `granted: true` (additive optional field of `PendingState.approvals`) so
  `resolveWait()` can continue without a second approval answer (spec 11 §3.5).
- Partial `respond()` for approvals stays roadmap: only external results are recorded one by one.
- Without an adapter `setIf` and without a lock, two instances recording the same wait can both
  succeed (last write wins); the multi-instance guide already requires one of them.
