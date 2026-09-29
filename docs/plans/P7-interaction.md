# P7 — Interaction: approvals, respond, regenerate/edit, steer, queue, wake

Status: todo · Branch: `phase/P7-interaction`

## Goal

Everything a user or UI does to a session besides sending a new message, on top of the P2 runtime:
human-in-the-loop tool approval, client-side tools, regenerate/edit with rewinds, steering and
queueing while a turn runs, background wake-ups, and the `useChat` adapter `handleChatRequest`.

## Specs

- 11 (all)
- 05 §2, §3 (operation checks, commit point), §7 (`pending`, `grants`, `rewinds`)
- 04 §2 (continuation turns), §6 (attach caveat)
- 03 §5 (`eh.rewind`), §6 (`data-eh.input` split, `deliveredIn`)
- ADR-0011, ADR-0012

## Owns

`src/session/interaction/**`, `src/stream/chat-request.ts`. Small, separate commits in
`src/session/**` and `src/loop/**` for the hooks P2 left (operation checks, step-boundary
delivery queue).

## Checklist

1. [ ] Pending state: detection at step end (spec 11 §2), `state.core.pending`,
   `metadata.eharness.pending`, `stats().pending`, `pending` session event.
2. [ ] Approval function per step: policy + `tool.approve` hooks + grants, most restrictive wins,
   fail closed, `approval.secret` → `experimental_toolApprovalSecret`.
3. [ ] `respond()`: state re-read, validation (`unknown-id`, `incomplete`, `stale`), atomic
   consume before any execution (commit-point write with `setIf` when available), part patching
   by **merging** approval objects, `pending: null`, grants effective after step 0, continuation
   into the same message (`originalMessages`, `start` without metadata), step 0 wire ending with
   the approval `tool` message (no reminder, no `data-eh.input`), client tool outputs through
   `tool.after` + limits.
4. [ ] `onNewInput` (`deny` patching / `reject` → `EH_PENDING_RESPONSE`) for send/regenerate/edit.
5. [ ] `eh.rewind`, view rule in loader and `messages({ includeHidden })`, `state.core.rewinds`
   mirror + healing, `regenerate()`, `edit()` with `clientId` carry-over, `'not-found'` and
   `'beyond-compaction'` errors.
6. [ ] `ifBusy`: `steer` (normalize + `input.submit` immediately, delivery at the next boundary,
   forced continuation, fallback to queue), `queue` (in-memory FIFO, runs after the current turn,
   dropped on abort/close), `reject`.
7. [ ] `inject()` options: `deliver: 'next-step'` (`data-eh.input { source: 'event' }` +
   `deliveredIn`), `wake` (idle → no-input turn; running → next-step).
8. [ ] `handleChatRequest` dispatch (spec 11 §7) with `extractResponses` reading only decision
   fields.
9. [ ] Integration tests: scenarios 17–26 of testing.md; round-trip reload after each operation.

## Acceptance criteria

- [ ] A `useChat` client (driven by `@ai-sdk/react` test utilities or recorded request bodies)
      completes: submit → approval → approve → answer; regenerate; edit; steer during a tool loop.
- [ ] No test can make a tool execute twice or execute after a stale/replayed answer.
- [ ] Reloading after every operation reproduces the same model wire as the hot session.

## Open questions

## Requests to other phases

- From P2: stubs to replace — `respond()`, `regenerate()`, `edit()` return a failed run with
  `EH_NOT_IMPLEMENTED` (`failedRun()` in `src/session/session.ts`); `send(…, { ifBusy: 'queue' |
  'steer' })` throws `EH_SESSION_BUSY` while a turn runs; `inject()` rejects `deliver: 'next-step'`
  and `wake` with `EH_NOT_IMPLEMENTED`. Pending: a `tool-pending` stop writes
  `state.core.pending`, `metadata.eharness.pending` and a `pending` event (`onEnd` in
  `src/session/turn.ts`); the next `send()` just clears `state.core.pending` at the commit point
  and projects with `pending: null` (open calls reach the model as `INTERRUPTED_UNKNOWN`) —
  replace with `approval.onNewInput`. The approval function (`buildApproval()` in
  `src/registry/wrap.ts`) has no grants yet; `approval.secret` is already passed as
  `experimental_toolApprovalSecret`. Step-boundary delivery is the `waiting` queue in `runSteps()`
  (`src/loop/steps.ts`), currently fed by `step.end` context and `turn.beforeEnd`; steers and
  `next-step` injections go there (and not before step 0 of a `respond` turn). The loader applies
  the rewind view rule (`hiddenByRewind()` / `rewindsIn()` in `src/session/load-context.ts`) but
  does not heal `state.core.rewinds`; `messages()` filters with page rewinds + the state mirror.
  When the last stub is gone, `EH_NOT_IMPLEMENTED` can leave the error union (see P8).
- From P2 (review): `buildApproval()` (`src/registry/wrap.ts`) lets a throwing `approval.policy`
  (per-tool function or generic function) propagate, while throwing `tool.approve` hooks count as
  `denied`. Spec 11 §3 is fail-closed: catch policy errors too and treat them as `denied` (with the
  error message as reason), and add a test.
- From P3: compaction is wired for `send()` only. `src/session/turn.ts` builds the turn wire with
  `createTurnCompaction()` (`src/compaction/turn-context.ts`) and `currentTurnStartId()`
  (`src/compaction/turns.ts`), which already implements the current-turn rules of spec 06 §5.1 for
  `{ kind: 'respond', messageId }`, `{ kind: 'regenerate', assistantId }` and `edit` (= `'input'`).
  For `respond()` pass `pending` / `continuing` to `createTurnCompaction()` (used for projection)
  and pass the continuation's extra wire (the `tool` message with the approval responses, which is
  not in the cached view) as `delivered` to `build()` — the loop re-appends
  `wire.slice(sinceBarrier)` after a mid-turn rebuild, so it must also be counted there. Manual
  `compact()` already keeps the pending message's turn (`currentTurnStartId(…, { kind: 'respond' })`).
  Rewind × compaction: the loader and `rt.view` exclude hidden messages before compaction sees them;
  `'beyond-compaction'` must compare `afterId` with the newest boundary's `resumeFromId`
  (`payloadOf()` in `src/compaction/turns.ts`).
- From P6: client tool outputs (`respond({ toolOutputs })`, spec 09 §6) must pass through
  `tool.after` and the output limits like server outputs. The limit helper is
  `limitToolOutput(toolName, toolCallId, output, { config: rt.agent.config.toolOutput,
  toolOutputs: open.services.get('toolOutputs'), warn: rt.warn })` in
  `src/registry/output-limits.ts` (strings → head + tail, structured →
  `{ truncated, preview, originalChars }`, `evict` via the `toolOutputs` service,
  `W_TOOL_OUTPUT_LIMITED`); run the `tool.after` chain first (see `finish` in `wrapTool()`,
  `src/registry/wrap.ts`).
