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
