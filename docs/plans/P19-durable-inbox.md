# P19 — Durable inbox port

Status: done · Owner: agent · Branch: `main` (direct commits; P13–P20 ship together as **0.4.0**)

Source: 0.4 proposal item **U3** (roadmap item "Cross-process queue / wake") plus the inbox
path of **U4** (cross-process abort, state path done in P16).

## Goal

Multi-instance deployments can queue, steer, wake, collect (debounce) and abort **across
processes** through an optional `InboxAdapter` port next to `MessageAdapter` / `StateAdapter`.
Without an inbox, 0.3 behaviour is unchanged (in-memory queue per process). eharness ships only a
memory adapter and a conformance suite; a Postgres adapter (`FOR UPDATE SKIP LOCKED` +
`LISTEN/NOTIFY`) is an example in `examples/`.

## Specs / docs to read

- `docs/specs/05-session-and-storage.md` §1 (session cache, idle eviction, queue keeps session
  alive), §2 (`SendOptions.ifBusy`, failure semantics), §3 (commit point, step boundary delivery),
  §4 (adapter contract style), §7 (state, `setIf`), §8 (`SessionLock`), §9 (`activeTurn`,
  `recovery.staleMs`, heartbeat), §10 (Postgres reference)
- `docs/specs/11-interaction.md` §6 (steer, queue, `inject` delivery and wake, `deliveredIn`,
  "wake is never lost")
- `docs/specs/04-streaming.md` §6 (`SessionEvent`)
- `docs/specs/03-messages.md` §3 (`metadata.eharness`), §4.3 (`data-eh.input`)
- `docs/specs/10-errors-and-stop-reasons.md` §1 (`EH_SESSION_BUSY`)
- ADR-0008 (memory adapters only), ADR-0011 (stored order = model order), ADR-0012
- `docs/plans/P16-cross-process-abort.md` (abort request semantics reused)
- `src/session/interaction/inbox.ts`, `queue.ts` (existing **internal** `InboxItem` / `TurnInbox`
  names — see open questions)
- `examples/postgres-storage.ts`, `docs/guides/writing-a-storage-adapter.md`

**AI SDK:** none (storage port). Postgres facts used by the example (verify against the Postgres
17 docs while writing it): `SELECT … FOR UPDATE SKIP LOCKED`
(`https://www.postgresql.org/docs/17/sql-select.html#SQL-FOR-UPDATE-SHARE`), `LISTEN` / `NOTIFY` /
`pg_notify` (`https://www.postgresql.org/docs/17/sql-notify.html`).

## Owns

`src/session/**` (new `inbox/` folder: drain loop, collect timer, dedupe), `src/agent/types.ts`
(`storage.inbox`), `src/storage/memory.ts` (`memoryInbox()`), `src/testing/inbox-adapter.conformance.ts`
(new) + `src/testing/index.ts`, specs 05 / 11 / 04 / 03 / 10, ADR-0024,
`docs/guides/multi-instance.md` (new), `docs/guides/writing-a-storage-adapter.md`,
`examples/postgres-inbox.ts` (+ CI Postgres service already present), `examples/inbox.ts`.

## Design

```ts
export interface InboxAdapter {
  /** Durable before resolving. Returns the item id (time-sortable). */
  enqueue(sessionId: string, item: InboxItemInput): Promise<string>
  /** Atomically claim ready items of a session for `owner`, oldest first. Claimed items are invisible to other claims until ack/release or claim expiry. */
  claim(sessionId: string, owner: string, opts?: { limit?: number; claimTtlMs?: number }): Promise<InboxItem[]>
  ack(ids: string[]): Promise<void>
  release(ids: string[]): Promise<void>
  /** Optional wake-up of the process holding the session (LISTEN/NOTIFY, pub/sub). Without it: polling. */
  notify?(sessionId: string): Promise<void>
  /** Optional subscription used by the holder; without it the core polls every `pollMs`. */
  subscribe?(sessionId: string, onNotify: () => void): () => void
  /** Optional: sessions with ready items (for an app-level sweeper). */
  pending?(opts?: { limit?: number }): Promise<string[]>
}

export type InboxItemInput =
  | { kind: 'send'; mode: 'queue' | 'steer' | 'collect'; input: SerializedInput; collect?: CollectOptions; at: number }  // clientId lives in input
  | { kind: 'wake'; messageId: string; at: number }        // inject(…, { wake }) from another process; the kind message is already saved
  | { kind: 'abort'; turnId?: string; reason?: string; at: number }
export type InboxItem = InboxItemInput & { id: string; attempts: number }

defineHarnessAgent({ storage: { messages, state, inbox }, inbox: { pollMs?, claimTtlMs?, collect? } })   // inbox optional (also SessionOptions.storage)
send(input, { ifBusy: 'queue' | 'steer' | 'collect' | 'wait' | 'reject', collect?: { quietMs?: number /* 1_500 */; maxWaitMs?: number /* 10_000 */; maxItems?: number /* 20 */ } })  // in-process only
session.enqueue(input, { mode?: 'queue' | 'steer' | 'collect', collect? }): Promise<{ inboxId; target: 'local' | 'remote' }>
```

Normative rules (spec 05 new §12 "Inbox", spec 11 §6 updates):

1. **Without inbox:** unchanged (in-memory queue; `collect` works in-process with a timer).
2. **Enqueue path** (open question 1 → (c)). `send()` keeps its 0.3 semantics (a turn running
   elsewhere is a run error `EH_SESSION_BUSY`; `ifBusy` applies to local turns only). The
   cross-process path is `session.enqueue(input, { mode, collect })`: with an inbox it stores the
   item, emits `inbox-enqueued`, reads the state and resolves `{ inboxId, target: 'remote' }` +
   `notify?` when a live foreign `activeTurn` exists, else `target: 'local'` and drains at once.
   Without an inbox it applies the input in-process (`target: 'local'`).
3. **Drain.** Every live session with an inbox claims on notify, every `pollMs` (default 2 000)
   and when its turn (or `compact()`) ends. While a turn runs here: steers are pushed into the
   turn (delivered at the next step boundary as `data-eh.input` with `inboxId`), matching aborts
   abort it, everything else is released. When nothing runs or is queued here: a live foreign
   `activeTurn` → release and stop claiming until it is gone; otherwise the first unit (one
   queue/steer item, consecutive wakes, or a due collect burst) starts as a queued turn and the
   rest is released (drained again at its turn end). Claims are held only from claim to the
   commit point (or step save) of the turn that applies them.
4. **Abort items** (U4 inbox path): `requestAbort()` (P16) prefers the inbox when configured
   (`enqueue abort` + `notify`), the state path stays the fallback; the holder checks abort items
   at boundaries and on notify, matching `turnId` as in P16.
5. **At-least-once with dedupe.** Items are acked **after** their effect is durable: a queued
   send after its user message is saved (commit point); a steer after the snapshot containing its
   `data-eh.input` is saved; a wake after its turn committed; an abort after the abort is
   recorded. Dedupe on redelivery: user messages carry `metadata.eharness.inboxId`; input parts
   carry `inboxId`; the core keeps `state.core.inboxDelivered` (last 100 ids, written with the
   commit-point / step state write) and skips (acks) items already delivered. A claimed item whose
   owner died is released by claim expiry (`claimTtlMs`, default `recovery.staleMs`).
6. **Collect.** Items with `mode: 'collect'` are merged into **one** user message after
   `quietMs` without a new item, or `maxWaitMs` since the first, or `maxItems`: texts joined with
   a blank line in arrival order, files concatenated, `metadata.eharness.collected: Array<{
   inboxId?, clientId? }>`. `input.submit` runs once on the merged message (`via: 'queue'`). In a
   running turn, collect items wait for the turn end (they are not steers).
7. **Ordering.** Per session, items are processed in id order; steers that miss the running turn
   become queued sends (spec 11 §6.1 rule) with their original id order.
8. **Pending approvals hold the inbox** like the in-memory queue (spec 11 §6.2); abort items are
   never held.
9. **Events:** `session.events()` gains `{ type: 'inbox-enqueued'; inboxId; kind; mode? }` (in
   the enqueuing process) and `{ type: 'inbox-drained'; inboxIds; turnId? }` (in the draining
   process).

## Checklist

- [x] Resolve open question 1 (remote-queued run result shape) in this file before coding; update
      the Design section.
- [x] ADR-0024 "Durable inbox port" (port vs app job queue, at-least-once + dedupe, why memory
      adapter + conformance only, collect semantics, relation to `SessionLock`).
- [x] Specs: 05 (§1 storage option, §2 `ifBusy: 'collect'`, `collect` options, new §12 Inbox,
      §11 I/O table), 11 §6.1–§6.3 (cross-process paths, wake from another process now
      supported with an inbox), 04 §6 events, 03 §3 `inboxId` / `collected`, §4.3 `data-eh.input`
      `inboxId`, 10 (warnings e.g. `W_INBOX_FAILED`), 05 §7 `core.inboxDelivered`.
- [x] Rename the internal `InboxItem` / `TurnInbox` in `src/session/interaction/inbox.ts` to
      `PendingInput` / `TurnInputQueue` (internal, no API change) so public names are free.
- [x] Conformance first: `inboxAdapterConformance(factory)` in `eharness/testing` — durability
      (resolve = visible), FIFO per session, claim exclusivity under concurrent claimers (exactly
      one wins per item), claim expiry, `release` returns items, `ack` removes, session isolation,
      copies, optional `notify`/`subscribe` delivery, `pending()` when present. `memoryInbox()`
      passes it.
- [x] Multi-process simulation tests first (`src/session/inbox.int.test.ts`: two agents sharing
      `memoryMessages()`, `memoryState()`, `memoryInbox()`, a memory `SessionLock`):
  - [x] steer from B reaches A's running turn at the next boundary (stored order = model order);
  - [x] queue from B runs as A's next turn; wake from B starts a turn when A is idle;
  - [x] collect: three sends within `quietMs` → one turn with one merged user message;
        `maxWaitMs` and `maxItems` flush;
  - [x] abort from B via inbox stops A (and via state when the inbox is absent — P16 test reused);
  - [x] restart mid-turn (A dies after claim, before ack) → item redelivered after claim expiry
        and **not** duplicated (dedupe by `inboxId`);
  - [x] pending approvals hold queued items; abort not held;
  - [x] no inbox → 0.3 behaviour (existing tests unchanged).
- [x] Implement drain loop, collect timer, dedupe, events.
- [x] Example `examples/postgres-inbox.ts` (table, `SKIP LOCKED` claim, `LISTEN/NOTIFY`
      `subscribe`), conformance-tested on the CI Postgres service like `postgres-storage.ts`;
      offline example `examples/inbox.ts` (two agents in one process) in `examples.test.ts`.
- [x] Guide `docs/guides/multi-instance.md` (lock, `setIf`, `lastId`, inbox, abort, sweeper with
      `pending()`); adapter guide section; `reference.md`; changeset; board.

## Acceptance criteria

- [x] All four item kinds work across two simulated instances; no item lost across a simulated
      crash; no item applied twice.
- [ ] `inboxAdapterConformance` passes for `memoryInbox()` and the Postgres example.
      (`memoryInbox()`: yes. Postgres: wired into `examples.test.ts` under `DATABASE_URL`, not run
      locally — no database in the agent sandbox; verify on the CI Postgres service.)
- [x] Without `storage.inbox`, behaviour and storage are byte-identical to 0.3 goldens.
- [x] `check:imports`: `src/testing/inbox-adapter.conformance.ts` imports core only via
      `src/index.ts`.
- [x] lint, typecheck, test, build, check:package, check:imports green.

## Changeset

`minor`:

- New optional port `InboxAdapter` (`storage.inbox`), `memoryInbox()` in
  `eharness/storage/memory`, `inboxAdapterConformance` in `eharness/testing`.
- `ifBusy: 'collect'` with `collect` options (also without an inbox, in-process).
- Cross-process queue / steer / wake / abort when an inbox is configured.
- New session events `inbox-enqueued`, `inbox-drained`; persisted additions
  `metadata.eharness.inboxId` / `collected`, `data-eh.input.inboxId`, `state.core.inboxDelivered`.
- Type-level: `SendOptions.ifBusy` gains `'collect'`; `SessionEvent` gains two members
  (exhaustive switches must add cases).

## Open questions

1. **Result of a `send()` that was enqueued for another process.** The run cannot stream the
   remote turn (cross-process resumable streams are roadmap). Options: (a) new stop reason
   `'queued'` with `TurnResult.queued = { inboxId }`; (b) `send()` returns the run as today but
   `run.result` resolves `{ stop: 'aborted', error: { code: 'EH_QUEUED_REMOTE' } }` (misleading);
   (c) a separate method `session.enqueue(input, opts): Promise<{ inboxId }>` and `send()` keeps
   current semantics (a busy-elsewhere session is a run error `EH_SESSION_BUSY`, as in 0.3).
   Conservative pick until decided: **(c)** — no new stop reason, no change to what `send()`
   returns, and the cross-process path is explicit: `session.enqueue(input, { mode: 'queue' |
   'steer' | 'collect', collect? })`, which enqueues locally-or-remotely and resolves with
   `{ inboxId, target: 'local' | 'remote' }`. `handleChatRequest` gets no new mode: a route that
   wants cross-process queuing calls `enqueue()` itself on the 409 busy run (P13 item 3).
   **Decided (orchestrator, 2026-10-05): (c).** `send()` keeps its 0.3 semantics; the
   cross-process path is the explicit `session.enqueue()`. Update rule 2 and the changeset
   accordingly.
2. Public name `InboxItem` collides with the internal type; decision: rename the internal one.
3. Poll interval default (`pollMs` 2 000 while live): acceptable cost? Adapters with `subscribe`
   avoid it.
4. `collect` while idle delays the first reply by `quietMs`; that is the intended chat
   behaviour (WhatsApp/Telegram bursts). Decision made.

5. **Decided while implementing (conservative picks, review welcome):**
   - Durable items are never dropped by `abort()` (released back to the inbox); only in-memory
     queued turns are dropped. An abort item for another `turnId` is acked without effect, and
     an abort item does not drop durable queued items ahead of it.
   - A steer that misses the running turn is **released** (not kept claimed in the in-memory
     queue): long turns would outlive the claim. It becomes a queued send at the next idle
     drain, and its `input.submit` hooks run a second time (`via: 'queue'`).
   - The poll keeps running with `subscribe` (safety net for lost notifications); `pollMs: 0`
     turns it off. A live session also drains once when it is created (sweeper path:
     `agent.session(id)` for each id of `pending()`).
   - `enqueue()` has no `SendOptions` (model, settings, runtime are not serializable); the
     holder's defaults apply. `target` is a best-effort hint (state read at enqueue time).
   - Collect across processes: a burst is a run of consecutive `collect` items; its debounce is
     the first item's `collect` over `config.inbox.collect`; it is claimed only when due (claim,
     check, release until then).
   - `inbox-drained` is also emitted without an inbox (local `enqueue()` items) when their turn
     commits; local `enqueue()` user messages carry `inboxId` too (only `enqueue()` paths;
     `send()` storage is unchanged).
   - `postgres-inbox.ts` uses `pg_notify` on one channel per schema with the session id as
     payload (session ids may exceed the 63-byte channel name limit); `subscribe` needs a
     `PgListener` (`bunSqlListener()` in the runner, node-postgres wiring in the header comment).

## Requests to other phases

- P13 items 1, 3, 6 (single-flight load, `idle()`, one live handle) are prerequisites.
- P16: `requestAbort()` gets an inbox branch here; keep its result type stable
  (`'remote'` for both paths).
- P20: production guide multi-instance section; results table U3/U4.

## Dependencies

**P13** and **P16** (hard).
