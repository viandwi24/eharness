# Spec 20 — Subagent plugin (`eharness/subagent`)

Status: **Draft (P31)**. Module: `src/subagent/*`. Built only with the public core API (ADR-0008).
Design: ADR-0034 (three deployment profiles), ADR-0035 (nested approvals park the parent), ADR-0037
(parent / child index), ADR-0027 (external waits).

`subagents(options)` adds the `agent` tool: the model delegates a self-contained task to another
agent, which runs as a **child session** (spec 05 §13) and returns a final report.

## 1. API

```ts
import {
  subagents, subagentChild, pendingSubagentApprovals, subagentWaitId,
  SUBAGENT_TOOL, SUBAGENT_NO_USER, SUBAGENT_NO_CLIENT,
} from 'eharness/subagent'

subagents({
  agents: Record<string, { agent: HarnessAgent; description: string; maxTurns?: number }>
        | (() => Record<string, …>),          // evaluated once per session
  toolName?: string                            // 'agent'
  maxDepth?: number                            // 2: the root is depth 0; a session at maxDepth has no tool
  maxConcurrent?: number                       // 8, per nesting depth and plugin instance
  background?: boolean                         // false; 'inline' and 'policy' only
  backgroundInChildren?: boolean               // false: run_in_background only in sessions without a parent (§2.2)
  approvals: 'inline' | 'park' | 'policy'
  answer?: (request: SubagentApprovalRequest, signal: AbortSignal)
            => Promise<SubagentApprovalAnswer> | SubagentApprovalAnswer   // required for 'inline'
  policy?: 'deny' | 'approve'                  // 'policy': default 'deny'
  childSessionId?: (parentSessionId: string, toolCallId: string) => string   // `${parent}:agent:${toolCallId}`
  timeoutMs?: number                           // 'park': timeout of the parent's wait (default none)
  parentAgent?: () => HarnessAgent             // see §3.1 (the agent is itself a child of a 'park' parent)
  selfAgent?: () => HarnessAgent               // 'park': this agent; reconciles its waits on session open, §3.4
  onParentRun?: (run: HarnessRun, parentSessionId: string) => void   // 'park', see §4
}): HarnessPlugin<'subagent'>

subagentChild({ parent: () => HarnessAgent, onParentRun? }): HarnessPlugin<'subagent-child'>
reconcileSubagentWaits(parentSession, { openChild, onParentRun?, log? }): Promise<SubagentReconcileEntry[]>   // §3.4
pendingSubagentApprovals(session, agentOrOpen): Promise<Array<{ sessionId; parentSessionId; pending: PendingState }>>

type SubagentApprovalRequest =
  | { type: 'approval'; agent; childSessionId; approvalId; toolCallId; toolName; input?; risk? }
  | { type: 'client-tool'; agent; childSessionId; toolCallId; toolName; input? }
type SubagentApprovalAnswer =
  | { approved: boolean; reason?: string; note?: string; remember?: 'once' | 'session' }   // approvals
  | { output: unknown } | { errorText: string }                                            // client tools
```

`subagents()` throws `TypeError` for `'inline'` without `answer` and for `'park'` with
`background: true`.

## 2. The tool

Input `{ subagent_type, description, prompt, run_in_background? }`. `subagent_type` is an enum of the
catalog keys, so an unknown type is an invalid tool call the model corrects. `run_in_background`
exists only with `background: true`. The description lists the types (resolved once per session, so
the prompt-cache prefix is stable).

- The child session id is deterministic (`childSessionId`). It is opened on `def.agent` with
  `SessionOptions.parent = { sessionId, turnId, toolCallId, depth: callerDepth + 1 }`. The child agent
  must share storage with the parent's agent (the child registers in the parent's state, ADR-0037).
- The child starts with no context; `maxTurns` is its `maxSteps`.
- Usage: the child's turn usage is added to the parent turn with `ctx.turn.addUsage(usage, { source:
  'subagent:<type>' })` (tokens and `costUsd`).
- Cap: `maxConcurrent` children at once per depth and plugin instance; extra calls wait for a slot
  (abortable). A depth limit removes the tool from sessions at `maxDepth`.
- The child session is closed (`closeSession`) when the call ends.

### 2.1 `'inline'` and `'policy'` (a normal tool)

An async-generator tool: it yields `SubagentProgress` objects as **preliminary outputs** (UI only:
status, steps, last tool, latest text) and its last value is the final output the model sees. It also
writes the persisted part `data-subagent.run` (id = tool call id) `{ toolCallId, sessionId, agent,
status: 'running' | 'done' | 'failed' }` so a UI can open the child transcript after a reload.

The child turn is driven until it ends: each `tool-pending` stop is answered and continued with
`respond()` on the child.

| Child stops with | `'inline'` | `'policy'` |
|---|---|---|
| approval | `answer({ type: 'approval', … })`; `approved` → approve (`note`, `remember` passed), else deny with `reason` (default `Denied by the user.`) | `policy: 'approve'` approves; `'deny'` denies with `SUBAGENT_NO_USER` |
| client tool call | `answer({ type: 'client-tool', … })` → `{ output }` / `{ errorText }` | `errorText` `SUBAGENT_NO_CLIENT` |
| external wait (child's own) | not answerable in process: the child stops, the parent gets `[subagent stopped: tool-pending] …` | same |

A throwing or rejecting `answer` denies / answers with an error; an abort of the parent aborts the
child (`abortSignal` of the call is the child's send / respond signal and `answer`'s `signal`).

Final output (model-visible): the child's final text, or `(the subagent returned no text)`;
`[subagent stopped: <stop>] <text>` when the child ended `length` / `content-filter` / `timeout` …;
`ERROR: subagent failed: <message>` on a child error; `ERROR: subagent was aborted before it
started.` when aborted while waiting for a slot. Tools return errors as strings, never throw.

### 2.2 Background (`run_in_background`, `'inline'` / `'policy'`)

The call returns at once with `Started background subagent <task id> (<type>): <description>. You will
be notified when it finishes.` The task id is the `subagentTasks` registry id (`agent-1`, …), the
same id the UI and the completion notice use. The child runs detached (concurrency cap applies, aborted when the
parent session closes) and on completion the plugin calls `ctx.session.inject('eh.event', { name:
'subagent', text, data: { sessionId, agent, status } }, { deliver: 'next-step', wake: true })`: a
running parent sees it at its next step boundary, an idle one wakes. The event is a stored message,
so it survives restarts of the UI process. The report is capped at 4 000 characters. An inject that
fails (parent closed) is logged. Approvals follow the configured strategy; a wake run is not driven
by anyone — observe it with `session.onRun()` (in process, spec 05 §2.1) or `session.events()`.

**`subagentTasks` service (0.8).** The plugin `provides: ['subagentTasks']` (always, also without
`background`), per live session, in memory, like `shellTasks`:

```ts
interface SubagentTask {
  id: string                 // 'agent-1', per session
  agent: string; description: string
  childSessionId: string
  status: 'running' | 'completed' | 'failed' | 'stopped'
  startedAt: number; endedAt?: number
  tail: string               // latest text of the child (≤ 2 000 chars), else its latest tool call
}
interface SubagentTasks {
  list(): SubagentTask[]; get(id: string): SubagentTask | undefined   // task id or child session id
  stop(id: string): Promise<void>; stopAll(): Promise<void>
  subscribe(listener: (tasks: SubagentTask[]) => void): () => void   // tail updates throttled to 100 ms
  background(toolCallId?: string): string[]   // move running foreground agent calls to the background
}
```

`stop(id)` marks the task `stopped` first, then aborts the child (the abort signal of its turn);
the parent receives the `eh.event` with `data.status: 'stopped'` and a text that says it was
stopped (a stopped child counts as `failed` in the part). An id that is not a task of this
process is taken for a child session id: the plugin calls `requestAbort('stopped')` on it through
the catalog agents (spec 05 §9.1), which reaches a child running in another instance. Closing the
parent session stops every running task (`dispose`).

**Moving a foreground run to the background.** With `background: true` (same rules as
`run_in_background`: root session, or `backgroundInChildren`; `'inline'` and `'policy'`, not
`'park'`, where it is a no-op) `subagentTasks.background(toolCallId?)` detaches the running
foreground `agent` calls (Ctrl+B in Claude Code) and returns the new task ids (`[]` when none).
The tool call resolves at once with `Subagent moved to the background as task <id> (<type>):
<description>, by the user. Progress so far: <latest text or tool> You will be notified when it
finishes.`; its progress stream ends with a final `Moved to the background.` progress value and
that output. The child keeps running with its own abort controller: the tool call's abort signal
no longer reaches it (stop it with `stop(id)`), parent session close still aborts it. Completion
follows the background path above (task `agent-<n>`, `eh.event` report, `wake`, usage added to the
parent turn when it is still open, concurrency slot released at the end).

**Persisted marker.** The tool writes `data-subagent.run` `{ toolCallId, sessionId, agent,
status: 'running' }` (id = tool call id) when the background child starts. The final `done` /
`failed` is written with the same id only while the starting turn still streams; afterwards the
report event (`eh.event`, `data: { sessionId, agent, status }`) is the durable record, since a
stored message of an earlier turn cannot be amended.

**Children of children (the rule).** A report is injected into the session that started the
child. A child session closes when its turn ends, which aborts its background children
(`ctx.signal`), so a nested background run would be lost. Rule: `run_in_background` is only
offered in sessions **without a parent** (the root the user sees); `backgroundInChildren: true`
offers it in child sessions too, for apps whose child sessions stay open (the report then goes to
that child). No cross-session injection exists (the root session handle lives in another agent
and may be in another instance). Shell background tasks follow the same rule by configuration:
install `shell({ background: true })` only on the root agent and a `shell()` without `background`
on child agents (spec 19).

## 3. `'park'` (profile c): nested approvals, ADR-0035

The tool is an `externalTool()` (spec 11 §4.2): a tool **without `execute`**, so the parent turn
always stops `'tool-pending'` at the call, with an external wait `w_<toolCallId>`. No progress
(preliminary outputs) and no background mode in this strategy.

Sequence:

1. The parent's step ends with the `agent` call; the pending state (the wait) is committed; the
   tool's `start` runs inside the parent turn, after the commit.
2. `start` opens the child session (with `parent`), sends the prompt, and awaits the child's **first
   turn**. It is idempotent by `waitId`: a redispatched `start` finds a child with messages and does
   not send the prompt again (it reports the stored state, or resolves the wait from the child's
   final text when the child already finished).
3. The child stops `tool-pending`: `start` returns `{ correlationId: <childSessionId>, payload:
   { childSessionId, agent, description, status: 'waiting', pending: { approvals: […],
   clientTools: […] } } }`. The parent turn ends `'tool-pending'`; the wait stays parked, nothing is
   held in memory. `pendingWaits()` shows the child id and the pending items.
4. The application answers the **child**: `childAgent.session(childId).respond({ approvals })`
   (or `toolOutputs` for client tools), from any instance (`pendingSubagentApprovals(parentSession,
   childAgent)` lists the children with pending state; `session.children()` / the wait payload give
   the ids). The child may stop `tool-pending` again; step 4 repeats.
5. When a child turn ends with any stop other than `'tool-pending'` (in any instance), the plugin's
   `turn.end` hook on the **child** reads the parent's `pendingWaits()`, finds `w_<toolCallId>`
   (not found or already resolved: ignored, so inline / policy / background children and late
   reports are harmless) and calls `parentSession.resolveWait(waitId, result)`:
   `complete` → `{ output: finalText }`; `error` / `aborted` → `{ errorText: 'ERROR: subagent …' }`;
   other stops → `{ output: '[subagent stopped: <stop>] <text>' }`.
6. `resolveWait()` records the result (compare-and-set) and, as nothing else is pending, continues
   the **same** assistant message like a `respond()` continuation. The parent model reads the report
   as the tool result.

A child that finishes during step 2 follows the same path: its hook runs while the parent turn is
still running in this instance (`resolveWait()` → `EH_SESSION_BUSY`); the hook retries in the
background (20 ms doubling to 1 s, 60 tries) until the turn ended. In another instance the first
attempt succeeds.

### 3.1 How the child side reaches the parent (no core handle)

Resolving the wait needs the parent session. The core exposes only `ctx.session.inject` (spec 01),
so the child-side hook gets the agent that owns the parent sessions from configuration:

- child agents install `subagentChild({ parent: () => parentAgent })`; the function form lets two
  agents reference each other;
- an agent that is both a child and a parent passes `subagents({ …, parentAgent: () => … })`
  instead (its hook is included).

The plugin must be installed on **every instance that can complete a child turn** (applications
already register the same plugin set on all instances for external waits). Both agents use the same
storage (message / state adapters with `setIf` or a lock, as for any external wait).
`onParentRun` receives the continuation run `resolveWait()` started on the parent (stream it to
the user, or let it run: by default it is drained and stored; read it with `session.attach()` /
`events()`).

### 3.2 Failure rules

- Child turn error or abort: the wait resolves with an `ERROR:` text (the parent model can react).
- Parent abort while `start` runs: the abort signal is the child's `send` signal. Once the parent is
  parked there is no running parent turn; stop the child with `childSession.abort()` (cross-process
  abort, ADR-0021) — its turn then ends `aborted` and resolves the wait.
- Timeout: `timeoutMs` (the wait's own timer / inbox timer / `expireWaits()`, ADR-0027); the default
  `onTimeout` is `WAIT_TIMED_OUT`. A report after a timeout is `already-resolved` and ignored.
- A `start` precondition failure (unknown type, no turn) resolves the wait at once with an `ERROR:`
  text through an immediately due `onTimeout`.
- A crash after the child finished and before the hook's `resolveWait()` is healed by
  `reconcileSubagentWaits` (§3.4); without it the wait stays parked until `timeoutMs` or a manual
  `resolveWait`, so set `timeoutMs` in production anyway.
- The concurrency slot is held while `start` awaits the child's first turn, not while parked.

### 3.3 Server recipe

```ts
const main = defineHarnessAgent({ ..., plugins: [subagents({ agents: { worker: { agent: worker, description } }, approvals: 'park', timeoutMs: 3_600_000 })] })
const worker = defineHarnessAgent({ ..., plugins: [subagentChild({ parent: () => main })] })   // same storage

// POST /chat: the parent turn stops 'tool-pending'; show "waiting for approval in <agent>".
// GET /pending: await pendingSubagentApprovals(main.session(parentId), worker)
// POST /answer: worker.session(childId).respond({ approvals: [{ id, approved: true }] })
//               (any instance; the parent continues by itself when the child completes)
```

### 3.4 Reconciliation (crash recovery)

```ts
reconcileSubagentWaits(parentSession, {
  openChild: (childSessionId, { agent, toolCallId }) => HarnessSession,
  onParentRun?: (run, parentSessionId) => void,
  log?: { warn(message, data?) },
}): Promise<Array<{ waitId; childSessionId; status: 'resolved' | 'busy' | 'skipped' }>>
```

For every pending wait `w_<toolCallId>` without a result it finds the child (payload
`childSessionId`, else `children()` by `toolCallId`, else the `correlationId`), opens it with
`openChild` and reads stored state only. A child is **finished** when it has no pending state, no
active turn and its last assistant message has a `metadata.eharness.stop` other than
`'tool-pending'`; the wait is then resolved with exactly the result the `turn.end` hook would use
(`complete` → final text, `error` / `aborted` → `ERROR: subagent …`, other stops →
`[subagent stopped: …]`). Otherwise the entry is `skipped`. A parent that runs a turn gives `busy`
(retry later). Idempotent: the result is recorded with the wait's compare-and-set, so racing the
hook, another instance or a second call is harmless.

Automatic: with `approvals: 'park'` and `subagents({ selfAgent: () => parentAgent })` the plugin's
`session.start` hook starts a reconcile **detached**: opening the session never waits for it and
never fails on it (failures are logged as warnings). The option exists because the hook context
has no session object. Manual use (an admin endpoint, a timer, a `ready()` after a deploy) needs no
option. A session is opened by `send()`, `stats()`, `ready()`, …; reading `messages()` alone does
not open it.

## 4. Multi-instance and restarts

Everything the strategy needs is stored: the parent's pending wait, the child's pending state, the
parent / child index (`core.parent`, `core.children`). A restart between the park and the answer loses
nothing; the answering instance opens the child (and, through the hook, the parent) from storage.
`'inline'` keeps the child only in process; `'policy'` never parks.

## 5. Model-visible texts (a change is a minor change)

Tool description (see source `toolDescription`), `SUBAGENT_NO_USER`: "No user is available; this
action is not allowed in autonomous mode.", `SUBAGENT_NO_CLIENT`: "No user is available to answer
this call. Continue without it or choose another approach.", the final output forms of §2.1 and the
background event text and the `Subagent moved to the background as task …` result.

## 6. Tests

`src/subagent/subagent.test.ts`: inline approve / deny with feedback / client tool, policy
deny / approve, child error, abort propagation, depth limit, per-depth concurrency, background wake,
park (another instance answers; parent process restart; child finishes at once; child fails),
`reconcileSubagentWaits` (child finished without the hook, still waiting, `selfAgent` on open),
`pendingSubagentApprovals`, `subagentTasks` (list / tail / stop / `run` part), `backgroundInChildren`.
Core: `src/session/context-inject.int.test.ts` (`ctx.session.inject`).
