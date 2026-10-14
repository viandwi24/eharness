# Spec 33 — Limits (`eharness/limits`)

Status: **Draft (0.8)**. Module: `src/limits/*`. Builds on spec 01 (plugins, hooks), 05 §3.1
(`turn.beforeEnd`, wrap-up) and 12 §4.1 (budget ledger).

Three small plugins that every long-running product ends up writing. The module imports core only
through `src/index.ts`, has no dependency and no Node-only code. Generalised from the team app.

## 1. `stepBudget`

```ts
stepBudget({
  chunk?: number,                                   // steps added per extension, default 30
  cap: number | ((ctx: HarnessContext) => number),  // hard cap of total steps in a turn
  wrapUp?: boolean | string,                        // reminder in the last steps, default false
}): HarnessPlugin<'step-budget'>
```

A turn starts with the small `loop.maxSteps` of the runner. When it stops with `max-steps`,
`turn.beforeEnd` returns `{ extendSteps: min(chunk, cap - stepsRun) }` while there is room.

- The cap is the app's policy: a number, or a function of the session context (e.g. by session
  kind or origin). `cap <= 0` means "never extend": the runner's budget stands.
- No extension when the turn made no progress since the last continuation (`idleContinues > 0`).
  The progress guard (spec 05 §3.2) ends a repeating turn long before the cap.
- `e.stepIndex` of `turn.beforeEnd` is the index of the last step, so `stepIndex + 1` steps have
  run; the plugin never overshoots the cap.
- `wrapUp` adds a volatile `step.prepare` reminder when at most 3 steps remain before the cap
  (`true`: `STEP_BUDGET_WRAP_UP`; a string replaces it). It is a nudge only: `loop.wrapUp` (the
  core's tool-less summary step) stays the agent's setting and still runs when the budget is spent.
- Extensions count as continuations: `loop.maxContinues` still applies.
- `onCap?: { reminder: string | ((ctx) => string); extraSteps?: number }` (default 4 extra steps).
  When the turn reaches the hard cap (`cap > 0`) **while it still makes progress**
  (`idleContinues === 0`), `turn.beforeEnd` returns `{ extendSteps: extraSteps }` once per turn and
  `step.prepare` adds the reminder to every one of those steps (it wins over `wrapUp`); the app
  uses it to hand the job over (for example to a background worker). It never extends twice for
  `onCap`; after the extra steps the normal wrap-up and `max-steps` apply.

## 2. `budgetNotice`

When the budget ledger refuses a reservation the core stops the turn with `cost-cap` before the
model call and stores an empty assistant message; a chat shows nothing. Two parts fix that:

```ts
trackRefusals(ledger: BudgetLedger): RefusalTracker  // { ledger, take(sessionId), peek(sessionId) }
budgetNotice({
  refusals?: RefusalTracker,
  text?: (refusal: BudgetRefusal | undefined, sessionId: string) => string,  // '' = no notice
}): HarnessPlugin<'budget-notice'>
```

- Give `tracker.ledger` to `budget.ledger.adapter`; it forwards every call and remembers the last
  refusal (`scope`, `limitUsd`, `spentUsd`) per session (bounded to 500 sessions; the session id is
  read from the reservation key `${sessionId}:${turnId}:${stepIndex}`).
- `turn.end` with `stop: 'cost-cap'` stores an `eh.notice` (`level: 'warning'`, `code:
  'EH_COST_CAP'`) with `text(refusal, sessionId)` (default `defaultBudgetText`). An empty string
  stores no notice (a session that is not a chat). Without `refusals` the text is generic.
- A failure to store the notice is logged, never thrown.

## 3. `longRun`

```ts
longRun({
  sessions: LongRunSessions,                 // the agent, or () => agent (continuations are enqueued through it)
  state?: StateAdapter,                      // agent storage.state: for state(), resume(), stop() of a closed session
  match?: (ctx) => boolean,                  // which sessions run as jobs (default all)
  chunkSteps?: number,                       // steps per turn, default 80, at least 2
  maxCostUsd?: number | ((ctx) => number | undefined),
  maxDurationMs?: number | ((ctx) => number | undefined),
  checkpointPrompt?: string,                 // reminder of the last step of a chunk
  continuePrompt?: string | ((info: LongRunContinueInfo) => string),
  onEvent?: (e: LongRunEvent) => void | Promise<void>,
  now?: () => number,
}): HarnessPlugin<'long-run'> & {
  stop(sessionId, reason?): Promise<boolean>
  resume(sessionId): Promise<LongRunResumeResult>
  state(sessionId): Promise<LongRunState | undefined>
}
longRunState(state: StateAdapter, sessionId): Promise<LongRunState | undefined>   // read-only, for UIs
```

A job is a chain of bounded turns (chunks) on the durable inbox. The plugin contributes one tool,
`long_run_checkpoint({ note, done? })`, which the model calls at the last step of a chunk.

**State** (`state.plugins['long-run'].job`):

```ts
{ status: 'running' | 'finished' | 'stopped', chunk: number, steps: number, costUsd: number,
  startedAt: number, updatedAt: number, checkpoint?: string, stopReason?: string, activeChunk?: number }
```

`chunk` is the chunk running now, or the next one to run; it never repeats within a session (a new
job after a finished one continues the numbering). `steps` and `costUsd` sum the finished turns.

**Rules**

1. A job starts at the first turn of a session for which `match` is true (default: every session),
   or when a plain turn arrives after the previous job finished or stopped. The job state is set in
   `turn.prepare`, so it is written at the commit point of the turn. Event `started`.
2. A turn of a running job reaches its chunk limit at step `chunkSteps - 1`: `step.prepare` forces
   `long_run_checkpoint` (`toolChoice`) with `checkpointPrompt`. `step.end` then stops the turn with
   the stop reason `plugin:long-run:checkpoint` (exported as `LONG_RUN_CHECKPOINT_STOP` from core).
   If the model passes `done: true` the turn goes on and its final answer is the job's report.
   A loop `maxSteps` below `chunkSteps` is extended to the chunk size by `turn.beforeEnd` while
   the progress guard reports progress.
3. `turn.end` with that stop: `checkpoint` = the note, `chunk += 1`, steps and cost added, event
   `checkpoint`, then `session.enqueue(text, { id: 'longrun:<sessionId>:<chunk>', metadata:
   { longRun } })` (ADR-0040). The text is `continuePrompt` (default: includes the note). A failed
   enqueue is logged; the job stays `running` and `resume()` repairs it.
4. The job **finishes** (`finished`) when a turn ends `complete`. It **stops** (`stopped`,
   `stopReason`) when: the progress guard stops a turn (`stuck`), `costUsd` of the job (summed over
   turns, plus the current turn at every step) reaches `maxCostUsd` (`cost`), `now - startedAt`
   reaches `maxDurationMs` (`duration`), a turn ends `aborted` / `error` / `timeout` / any other
   stop (`stopReason` = the stop), or `stop()` was called (`stopReason` = its reason). A turn that
   ends `tool-pending` keeps the job running; the continuation after `respond()` is the same chunk.
5. A finished or stopped job never enqueues. A queued continuation (`metadata.app.longRun`) of a
   job that is not running is blocked by `input.submit` (stop `blocked`).
6. `stop(sessionId, reason)`: `false` unless the job is running. Otherwise the running turn is
   aborted (`session.abort`) or, between chunks, the stored state is set to `stopped` and the queued
   continuation is blocked. It acts in the process that holds the session; another process
   calls it where the session lives.
7. **Restart.** A crash leaves the job `running` and the turn interrupted (recovered like any
   stale turn, ADR-0014; interrupted tool calls are never re-executed). `resume(sessionId)` (boot,
   reconcile) reads the job from `state`, calls `session.recover()`, and does nothing when a turn
   runs (`live`) or the job is not running. Otherwise it enqueues a continuation: when the turn of
   the current chunk had started (`activeChunk === chunk`) the id is
   `longrun:<sessionId>:<chunk>:resume:<updatedAt>` and the text adds that the server restarted
   and that the model must check the last results before repeating anything with side effects
   (event `resumed` at that turn); otherwise the continuation of this chunk is still queued and
   the plain id is a no-op duplicate. Two calls enqueue once.
8. Events (`onEvent`): `started`, `checkpoint`, `resumed`, `finished`, `stopped` (with `reason`),
   each with the session id and a copy of the state. A throwing handler is logged.
9. **Background subagents.** A turn that ends `plugin:long-run:checkpoint` is not the end of the
   child: `subagent` neither reports it nor resolves a wait for it (park hook, reconcile). Only the
   final turn is reported; a stopped job reports status `stopped` (`plugin:long-run:*` stops). The
   background `timeoutMs` is measured from the start of the run that is running now (spec 20
   §3.6), so every chunk gets a fresh limit: the timeout bounds one chunk, not the job. Bound the
   job itself with `maxDurationMs` / `maxCostUsd`.

## Security notes

Nothing here widens authority: `stepBudget` only raises a step count up to an app-set cap, and
every step still reserves against the ledger.
