# P23 — Park-and-resume: external waits

Status: in progress · Owner: agent · Branch: `main` (direct commits; P21–P29 ship together as **0.5.0**)

Source: 0.5 prior-art item **#1** (verdict GENERIC-core; LangGraph `interrupt`, OpenAI Agents
`RunState` interruptions, Pydantic AI deferred tools, Mastra suspend/resume, Inngest
`waitForEvent`, Cloudflare `waitForApproval`, Strands interrupts). Partly covers the roadmap row
"Durable execution" (a turn parks at a tool boundary and resumes in any process).

Process (0.5.0): develop first, one gate at the end of the phase, consolidated review at the end
of the release.

## Goal

A tool can hand its result to the outside world and **park** the turn: the turn stops
`'tool-pending'` with a pending item of kind **external** (`waitId`, correlation id, payload,
`timeoutAt`), no process or worker is held, and the result arrives later — minutes or days — from
a webhook, a job, another agent or a person, in any instance. `session.resolveWait()` records
results one by one (validated, idempotent, compare-and-set); when nothing is pending any more the
**same** assistant message continues exactly like a `respond()` continuation (ADR-0012). Timeouts
resolve the wait with an explicit, per-wait result, through an in-process timer, a durable inbox
timer item (P22 `availableAt`) or an explicit `expireWaits()`. Design is snapshot-at-the-tool-
boundary: the parked call is answered, never re-executed (ADR-0014). Pending state is versioned.

## Specs / docs to read

- `docs/specs/11-interaction.md` §2 (pending state), §4 (`respond()` steps 1–5, consumption,
  continuation into the same message), §4.1 (new input while pending), §6.2 (pending holds the
  queue), §7 (`handleChatRequest`, `extractResponses`), §8 (security rules)
- `docs/specs/05-session-and-storage.md` §3 (commit point, step 15 pending write), §3.1
  (`tool-pending` decision), §7 (`state.core.pending`, `setIf`), §8 (`SessionLock`), §9
  (recovery, `INTERRUPTED_*`), §12 (inbox rules 3, 5, 8; P22 rules 11–15)
- `docs/specs/09-tools-and-mcp.md` §1 (what is wrapped), §6 (client-side tools)
- `docs/specs/04-streaming.md` §2 (continuation `start` chunk), §6 (`SessionEvent`), §7
- `docs/specs/03-messages.md` §3 (`metadata.eharness.pending`), §9 (schema evolution)
- `docs/specs/10-errors-and-stop-reasons.md` §4 (`'tool-pending'`), §5 (fixed texts)
- ADR-0011, ADR-0012, ADR-0014, ADR-0021 (cross-process abort), ADR-0024, ADR-0026 (P22)
- `src/session/interaction/pending.ts`, `src/session/turn.ts` (pending write, respond path),
  `src/loop/stop.ts`, `src/stream/chat-request.ts`, `src/session/inbox/driver.ts`

**AI SDK verified (2026-10-06):**

- A tool **without `execute`** ends the generation with the call unanswered: the loop continues
  only when every client tool call has an output or a denial
  (`packages/ai/src/generate-text/generate-text.ts`, around the client-tool check;
  `https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage`). eharness already relies on this for
  client tools (spec 09 §6); external tools use the same mechanism, so no stream chunk is
  rewritten (chunk order stays public API).
- AI SDK has **no** generic park/resume or "external tool" helper. What exists is unrelated or
  provider-scoped: provider-executed tools with `supportsDeferredResults` /
  `pendingDeferredToolCalls`, the approval request/response flow, and `WorkflowAgent`
  approvals (`https://github.com/vercel/ai/blob/main/packages/provider-utils/src/types/tool.ts`,
  CHANGELOG 7.0.128 at `https://raw.githubusercontent.com/vercel/ai/main/packages/ai/CHANGELOG.md`).
  So the wait registry is ours; the tool itself stays a plain AI SDK `tool()`.
- `tool.metadata` is a JSON object never sent to the model (`provider-utils/src/types/tool.ts`);
  `tool({ title })` is deprecated — do not use `title`.
- Continuations must stream into the same UI message via `originalMessages` (unchanged since
  P7; `https://ai-sdk.dev/docs/agents/tool-approvals`). **No devDependency bump needed.**

## Owns

`src/session/interaction/**` (new `waits.ts`), the pending / respond / recovery parts of
`src/session/turn.ts` and `src/session/session.ts`, `src/loop/stop.ts` (pending kinds),
`src/registry/wrap.ts` (external tool detection only), `PendingState` in
`src/messages/types.ts`, `src/session/inbox/driver.ts` (`wait-timeout` items only),
`src/stream/chat-request.ts` (kind check only), `src/index.ts` exports, specs 11 / 05 / 09 / 04
/ 03 / 10, ADR-0027 (new), `examples/external-wait.ts` (new), `docs/guides/external-waits.md`
(new, written here; P29 links it).

## Design

```ts
/** An AI SDK tool without `execute` whose result comes from outside (not from the client). */
export function externalTool<INPUT, OUTPUT>(def: {
  description: string
  inputSchema: FlexibleSchema<INPUT>
  /** Validates results given to resolveWait(). */
  outputSchema?: FlexibleSchema<OUTPUT>
  /** Starts the outside work once per call, after the step ended and before the pending state is
   *  committed. Receives a stable waitId (derived from the tool call id) to make it idempotent. */
  start?: (input: INPUT, e: { waitId: string; toolCallId: string; ctx: HarnessContext; abortSignal: AbortSignal })
    => Promise<WaitStart | void> | WaitStart | void
  /** Defaults per wait; start() may override. */
  timeoutMs?: number
  onTimeout?: { errorText: string } | { output: OUTPUT }      // default { errorText: WAIT_TIMED_OUT }
  metadata?: { risk?: ToolRisk; idempotent?: boolean }        // P21 traits
}): Tool<INPUT, OUTPUT>
export interface WaitStart { correlationId?: string; payload?: JSONValue; timeoutMs?: number; timeoutAt?: number; onTimeout?: … }

export interface PendingState {
  v?: 2                                             // written by 0.5; absent = 0.3/0.4 shape
  messageId: string
  approvals: …                                      // unchanged
  clientTools: Array<{ toolCallId; toolName; timeoutAt?: number; onTimeout?: … }>   // timeout used by P24
  externals?: Array<{
    waitId: string; toolCallId: string; toolName: string
    correlationId?: string; payload?: JSONValue
    timeoutAt?: number; onTimeout: { errorText: string } | { output: JSONValue }
    /** Recorded by resolveWait() before the continuation starts. */
    result?: { output: JSONValue } | { errorText: string; by: 'result' | 'timeout' }
  }>
}

session.resolveWait(waitId: string, result: { output: unknown } | { errorText: string }, opts?: SendOptions & { actor?: ApprovalActor })
  : Promise<{ status: 'continued'; run: HarnessRun<M> } | { status: 'recorded'; remaining: number }
           | { status: 'already-resolved' } | { status: 'not-pending' }>
session.expireWaits(now?: number): Promise<{ expired: string[]; run?: HarnessRun<M> }>
session.pendingWaits(): Promise<NonNullable<PendingState['externals']>>   // read helper for UIs/sweepers
// respond(): PendingResponse gains externals?: Array<{ waitId; output } | { waitId; errorText }>
// InboxItemInput gains { kind: 'wait-timeout'; waitId; at; availableAt }
// SessionEvent gains { type: 'wait-resolved'; waitId; by: 'result' | 'timeout' | 'cancel' }
```

Normative rules (spec 11 new §4.2 "External waits"):

1. **Parking.** At step end (spec 05 §3.1) an unanswered call of an `externalTool` is pending
   kind `external` (not `client`). Its `start` runs once, in tool-call order, before the
   commit-point write of the pending state; a throwing `start` answers that call with an error
   result (`String(error)` through `describeError`, the model can self-correct) and the step
   continues normally if nothing else is pending. `waitId` = `w_<toolCallId>` (stable, so `start`
   is idempotent on retry by the outside system).
2. **Several waits** in one step are all parked; approvals, client tools and externals may be
   pending together.
3. **Recording** (`resolveWait`). Validates `waitId` against `state.core.pending.externals`
   (else `not-pending`, never an error), validates `output` against `outputSchema`
   (`EH_INVALID_INPUT`, `details.reason: 'invalid-result'`), passes it through `tool.after` and
   output limits, and writes it with `setIf` (or under the session lock). The first result wins;
   the same result again → `already-resolved` (idempotent); a timeout racing a result → whichever
   CAS commits first. Callable from any instance; nothing runs in memory before the CAS.
4. **Continuation.** When the write leaves no unresolved item (no open approval, client tool or
   wait), `resolveWait` starts the continuation through the `respond()` path: consume pending,
   patch the stored tool parts to `output-available` / `output-error`, stream into the same
   message (`originalMessages`), ADR-0012 rules unchanged. If approvals or client tools are still
   open, results stay recorded and the later `respond()` uses them (it must not answer externals
   again; `externals` in `respond()` is for answering all at once).
5. **Kinds are enforced.** `handleChatRequest` / `extractResponses` never answer an external wait
   (a client output for an external `toolCallId` is ignored like a non-pending answer), and
   `respond({ toolOutputs })` for an external call → `EH_INVALID_INPUT` (`'wrong-kind'`). A
   browser can never resolve a server-side wait.
6. **Timeouts.** Each pending item with `timeoutAt` (externals; client tools from P24) is expired
   by (a) a timer in the live holding process, (b) with an inbox, a `wait-timeout` item enqueued
   at the commit point with `availableAt: timeoutAt` (P22) and applied by whichever instance
   drains it — never held by pending (like aborts), acked when the wait is already resolved,
   (c) `session.expireWaits(now)` for cron sweepers without an inbox. Expiry records
   `onTimeout` (`by: 'timeout'`) through the same CAS as rule 3.
7. **New input while waiting.** `onNewInput: 'deny'` answers open waits with `errorText:
   WAIT_CANCELLED_NEW_INPUT` (fixed text) at the commit point and emits `wait-resolved` with
   `by: 'cancel'`; late results then get `not-pending`. `'reject'` unchanged.
8. **Never re-executed.** Recovery (spec 05 §9) of a message whose wait was recorded but whose
   continuation died before its commit point resumes from the recorded result at the next
   operation; a call parked but never recorded in `state.core.pending` (crash between `start`
   and the commit) is answered `INTERRUPTED_CRASH` (ADR-0014) and `start` is not run again.
9. **Versioning.** `PendingState.v = 2` whenever written by 0.5; 0.3/0.4 state (no `v`) reads as
   before; an unknown `v` authorizes nothing (`resolveWait` → `not-pending`,
   `respond()` → `EH_INVALID_INPUT` `'stale'`) and warns `W_INVALID_MESSAGE`-style once.
10. **Holds.** Pending (incl. waits) holds the inbox and the in-memory queue as today
    (spec 11 §6.2, spec 05 §12 rule 8).

## Checklist

- [x] Spike first (record the result in this file): confirm with the scripted model that a tool
      without `execute` plus a core-side `start` gives the stored parts / chunks we need, and that
      projection of a resolved external part round-trips (ADR-0011). Keep the marker-in-`execute`
      variant rejected unless the spike fails (open question 1).
      **Spike result:** confirmed by `waits.int.test.ts` (no new stream shape): the call stays
      `input-available` while parked, the continuation streams `tool-output-available` into the
      same message, and a cold reload projects `user, assistant(call), tool(result), assistant`
      identical to the warm continuation prompt. The marker variant stays rejected.
- [x] ADR-0027 "External waits: park at the tool boundary" (amends ADR-0012/0014): snapshot vs
      replay, `externalTool` vs a marker, partial recording, CAS, timeouts via inbox timers,
      versioned pending.
- [x] Specs: 11 §2 (shape, `v`), new §4.2 (rules 1–10), §4.1, §7 (kind check), §8; 05 §3 / §3.1
      (pending kinds, `start` before the commit point), §7 (`core.pending`), §9 (recovery), §12
      (`wait-timeout` items); 09 §6 (external vs client); 04 §6 (`wait-resolved`); 03 §3; 10 §5
      (`WAIT_TIMED_OUT`, `WAIT_CANCELLED_NEW_INPUT`), §4 note on `'tool-pending'`.
- [x] Implement `externalTool()`, wait registry in `src/session/interaction/waits.ts`,
      `resolveWait`, `expireWaits`, `pendingWaits`, `respond({ externals })`, timers, inbox
      `wait-timeout` items, events, fixed texts (exported).
- [x] Tests (`src/session/interaction/waits.int.test.ts`):
  - [x] park → `tool-pending` with `externals`; `resolveWait` from a second simulated instance
        continues the same message; stored order = model order after cold reload;
  - [x] two parallel waits: first `recorded` (`remaining: 1`), second `continued`;
  - [x] wait + approval: results recorded, `respond({ approvals })` continues with both;
  - [x] duplicate result → `already-resolved`; result after timeout → `already-resolved`;
        concurrent result/timeout race with a `setIf` state adapter: exactly one wins;
  - [x] invalid result vs `outputSchema` → `EH_INVALID_INPUT` `'invalid-result'`, nothing stored;
  - [x] `handleChatRequest` cannot answer an external wait; `respond({ toolOutputs })` → `'wrong-kind'`;
  - [x] timeout via live timer, via inbox `wait-timeout` (two instances, holder gone), via
        `expireWaits`; `onTimeout` output vs errorText;
  - [x] new input with `'deny'` cancels waits; late result → `not-pending`;
  - [x] crash between `start` and commit → `INTERRUPTED_CRASH`, `start` not re-run; crash after
        recording → continuation on next operation;
  - [x] throwing `start` → error result, model continues;
  - [x] 0.4 pending state (no `v`, no `externals`) still answered by `respond()`; goldens of
        approval / client-tool flows unchanged.
- [x] `examples/external-wait.ts` (offline: a "build" tool parks, a simulated webhook resolves it;
      in `examples.test.ts`); guide `docs/guides/external-waits.md` (webhook route, correlation,
      sweeper, timeouts, idempotent `start`).
- [x] Changeset; board; gate.

## Acceptance criteria

- [x] A turn parks without holding a process; a result delivered to another instance continues
      the same assistant message; no tool runs twice; no wait resolves twice.
- [x] Every pending item with `timeoutAt` resolves exactly once with its explicit timeout result
      across the three timeout paths.
- [x] Clients cannot resolve external waits through `handleChatRequest`.
- [x] Sessions that never use `externalTool` are byte-identical to 0.4 except `PendingState.v`
      (documented; goldens updated once in a separate commit with the reason).
- [x] lint, typecheck, test, build, check:package, check:imports green.

## Changeset

`minor`:

- External waits: `externalTool()`, `session.resolveWait()`, `session.expireWaits()`,
  `session.pendingWaits()`, `respond({ externals })`, pending kind `externals` with `timeoutAt` /
  `onTimeout`, inbox item kind `wait-timeout`, session event `wait-resolved`, fixed texts
  `WAIT_TIMED_OUT` / `WAIT_CANCELLED_NEW_INPUT`.
- `PendingState` gains `v` and optional `externals`; `clientTools[]` gains optional `timeoutAt` /
  `onTimeout`.
- Type-level: `InboxItemInput` and `SessionEvent` gain members (exhaustive switches must add
  them); `EH_INVALID_INPUT` `details.reason` gains `'wrong-kind'` / `'invalid-result'`.

## Open questions

1. **Marker in `execute` vs a tool without `execute`.** A returned marker would be recorded by
   AI SDK as a real output (chunk `tool-output-available`), and the core would have to suppress
   and rewrite chunks — against "chunk order is public API". Pick: `externalTool()` without
   `execute` plus a core-run `start`. Revisit only if the spike fails.
2. **Partial `respond()`** for approvals stays roadmap ("Partial approval answers"); only external
   results can be recorded one by one.
3. **Who may call `resolveWait`.** The core cannot authenticate a webhook; the app verifies the
   caller (signature, correlation id) before calling it. `actor` is passed to a future
   `wait.resolved` hook? Pick: no new hook in 0.5.0 — the `wait-resolved` event plus
   `turn.end` cover audit; add a hook if the review asks.
4. **Max wait length / long timers.** In-process timers are capped (`setTimeout` 2^31-1 ms); longer
   waits rely on the inbox item or `expireWaits`. Pick: cap the in-process timer and document.
5. **`start` without a turn context** (e.g. needs `ctx.turn.addUsage`). Pick: `start` runs inside
   the turn (before its commit point), so `ctx.turn` is live.

6. **`resolveWait()` while a turn runs here.** Pick: `EH_SESSION_BUSY` (like `respond()`); the
   inbox path defers, the live timer re-arms at turn end. `opts.actor` is accepted but unused.
7. **Recording vs continuing after a crash.** Pick: a replayed result stays `already-resolved`
   (pure no-op); a fully recorded pending state is continued by `respond({})`, `expireWaits()`
   or new input (deny keeps recorded results). No dedicated "resume" API.
8. **`respond({ externals })` is not validated against `outputSchema`** (it is a trusted server
   call); `resolveWait()` is. Revisit if the review asks.
9. **Stale holder cache.** A session whose cache says "pending" now reloads state (and messages,
   when the pending message changed) at the start of any turn operation, because a continuation
   from another instance keeps the message id, so the `lastId` check cannot see it.
10. **`v: 2` on every pending state** (rule 9), so the unit tests that compared pending exactly
    were updated once (commit `test: pending v:2`); no golden file contained pending state.

## Requests to other phases

- P22: `availableAt` on inbox items (built there); this phase adds the `wait-timeout` kind.
- P24: request-scoped client tools use `clientTools[].timeoutAt` / `onTimeout` and the timeout
  paths of rule 6 (tab closed).
- P26: the guard may escalate to `user-approval` only (not to an external wait).
- P29: guide index, reference, results table row #1, roadmap "Durable execution" note.

## Dependencies

**P22** (hard: `availableAt` for durable timers). P21 recommended (traits on `externalTool`).
Wave W2, in parallel with P25.
