# External waits: park and resume

Some tools cannot answer inside a turn: a CI build, a human review, a webhook from a payment
provider, another agent. An **external wait** lets the tool hand its work to the outside world
and **park** the turn: it stops `'tool-pending'`, nothing is held (no process, no worker), and
the result arrives minutes or days later, in any instance. The same assistant message then
continues, exactly like a `respond()` continuation.

Contract: [spec 11 §4.2](../specs/11-interaction.md#42-external-waits) ·
decision: [ADR-0027](../decisions/0027-external-waits-park-at-the-tool-boundary.md) ·
runnable: [`examples/external-wait.ts`](../../examples/external-wait.ts).

## 1. Define the tool

```ts
import { externalTool } from 'eharness'
import { z } from 'zod/v4'

const build = externalTool({
  description: 'Run a CI build for a git ref and wait for its result.',
  inputSchema: z.object({ ref: z.string() }),
  outputSchema: z.object({ ok: z.boolean(), summary: z.string() }), // validates resolveWait() results
  start: async ({ ref }, { waitId }) => {
    await ci.trigger(ref, { idempotencyKey: waitId })               // idempotent: see below
    return { correlationId: `ci:${ref}`, payload: { ref } }
  },
  timeoutMs: 60 * 60_000,
  onTimeout: { output: { ok: false, summary: 'The build did not report back in time.' } },
})
```

`externalTool()` returns a plain AI SDK tool **without `execute`**, so the model call is streamed
and the turn ends with `stop: 'tool-pending'`; the result carries
`pending.externals[]` (`waitId`, `correlationId`, `payload`, `timeoutAt`, `onTimeout`).

- **`start` runs after the pending state is stored**, once per call in the normal case, inside
  the turn (`ctx.turn` is live). A webhook that fires immediately therefore finds the wait
  pending. `waitId` is `w_<toolCallId>`: stable, so pass it to the outside system as an
  idempotency key; `start` may run again (at least once) when an instance crashed between the
  commit and `start`, and the redispatch must not run the work twice. If `start` throws, you get
  `W_HOOK_FAILED`, the wait stays parked and ends by a result or its timeout (set `timeoutMs`).
  What `start` returns (`correlationId`, `payload`, timeouts) is stored right after it ran.
- Several waits in one step are all parked, next to approvals and client tools.
- Static and plugin tools are best: their `outputSchema` is checked when a result is recorded
  from any instance (tool-source tools are listed on demand).

## 2. Resolve from a webhook

```ts
// POST /webhooks/ci — runs in ANY instance, not necessarily the one that parked the turn
export async function POST(req: Request) {
  const event = await verifySignature(req)                // the core cannot authenticate a webhook
  const session = agent.session(event.sessionId)
  const outcome = await session.resolveWait(event.waitId, { output: event.result })
  // 'continued': the same assistant message continues; stream outcome.run to a client if you wish
  // 'recorded': stored, other approvals / waits are still open (outcome.remaining)
  // 'already-resolved': a replay — a no-op, answer 200
  // 'not-pending': unknown wait, or the pending state was consumed (new input, timeout) — answer 200
  return Response.json({ status: outcome.status })
}
```

Rules worth knowing:

- Results are **recorded one by one** with a compare-and-set on the stored state (`setIf`, or the
  session lock when your adapter has none). The first result wins; the same wait again is
  `already-resolved`, whatever its payload. A timeout racing a result is whichever write commits
  first, so a wait resolves exactly once.
- An `{ errorText }` result reaches the model as a tool error. An `{ output }` is validated
  against `outputSchema` (`EH_INVALID_INPUT`, `details.reason: 'invalid-result'`: nothing is
  stored, so the sender can fix and retry), then passes `tool.after` and the output limits.
- When the last open item is recorded, `resolveWait()` starts the continuation. If a turn runs in
  this instance it rejects with `EH_SESSION_BUSY` (retry; this also covers a callback that
  arrives while the parking turn is still running `start` — `'not-pending'` right after `start`
  does not happen in-process); if a turn starts between the write and
  the continuation the status is `'recorded'` with `remaining: 0` and the next `respond({})`,
  `expireWaits()` or new input continues.
- **Correlation.** Put your own id into `correlationId` / `payload` in `start`; the webhook maps
  it back to `sessionId` + `waitId` (keep that map in your database, or encode both in the
  correlation id). `session.pendingWaits()` lists the stored waits of a session for UIs.
- **A browser can never resolve a wait.** `handleChatRequest` ignores client outputs for external
  calls and `respond({ toolOutputs })` for one is `'wrong-kind'`. The server decides what a
  webhook is allowed to resolve.
- **Approvals and external tools.** An `approved` status (policy, `approval.risk`, a `tool.approve`
  hook, a session grant) means "no human needed": the call parks its wait as it does without a
  policy. A `user-approval` first asks a human; after `respond({ approvals })` approves, the wait
  is committed, `start` runs, and the turn ends `tool-pending` with the wait (no model step) until
  `resolveWait()` continues the same message. A denial gives the normal denied result and `start`
  never runs. Approved server calls of the same batch run after the wait is resolved; they are
  already granted, so `resolveWait()` needs no second approval answer.
- A wait next to an approval: record the result, then `respond({ approvals })` continues with
  both (the recorded result is used as recorded). `respond({ externals })` answers waits
  together with the rest in one call instead.

## 3. Timeouts

A wait with a timeout (`timeoutMs` on the tool, `timeoutMs` / `timeoutAt` from `start`) takes its
`onTimeout` result — `{ output }` or `{ errorText }`, default the fixed text `WAIT_TIMED_OUT` —
through the same compare-and-set as a result. Three paths, use what your deployment has:

1. a timer in the holding process (always on; capped at `setTimeout`'s 2^31-1 ms);
2. with `storage.inbox`, a durable `wait-timeout` item enqueued with `availableAt: timeoutAt`
   (spec 05 §12 rule 16): whichever instance drains the session applies it, so a wait still
   expires after the holder is gone. It is not held by pending approvals and is acked when the
   wait is already resolved;
3. `session.expireWaits(now?)` for a cron sweeper without an inbox:

```ts
// every minute, for sessions you track (or from adapter.pending() with an inbox)
for (const id of await sessionsWithOpenWaits()) {
  const { expired } = await agent.session(id).expireWaits()
  if (expired.length > 0) log.info('expired waits', { id, expired })
}
```

`expireWaits()` also continues a pending state whose waits are all recorded — an instance that
recorded the last result and died before continuing is picked up by the next sweep.

## 4. New input while waiting

With `approval.onNewInput: 'deny'` (the default) a new user message answers every **open** wait
with `WAIT_CANCELLED_NEW_INPUT` and emits `wait-resolved` with `by: 'cancel'`; results already
recorded are kept. A late result for the cancelled wait is `'not-pending'`. With `'reject'` the
new input fails with `EH_PENDING_RESPONSE` and the waits stay open.

## 5. Crashes and replays

- The parked call is **answered, never re-executed** (ADR-0014). A process that dies before the
  pending state is written leaves a dangling call: the next operation recovers it as
  `INTERRUPTED_CRASH`. A process that dies after the write but before `start` ran leaves the wait
  with `started: false`: once `recovery.staleMs` passed, the next session open or `expireWaits()`
  runs `start` again (same `waitId`).
- Replaying a webhook is safe: the recorded result is final.
- Stored pending state carries `v: 2`. State written by 0.3 / 0.4 (no `v`) still works with
  `respond()`; an unknown `v` authorizes nothing (`resolveWait` → `'not-pending'`).

## Events and testing

`session.events()` emits `{ type: 'wait-resolved', waitId, by: 'result' | 'timeout' | 'cancel' }` in
the process that recorded or cancelled the wait. In tests use two agents on the same memory
adapters (see `src/session/interaction/waits.int.test.ts` for the pattern: one instance parks,
another resolves) and `scriptedModel` for the model.
