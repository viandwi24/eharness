# Spec 20 — Subagent plugin (`eharness/subagent`)

Status: **Draft (0.7)**. Module: `src/subagent/*`. Built only with the public core API (ADR-0008).
Design: ADR-0034 (three deployment profiles), ADR-0035 (nested approvals park the parent), ADR-0037
(parent / child index), ADR-0027 (external waits), ADR-0038 (agent messaging: `send_message`, names,
resume), ADR-0041 (messaging in park mode), ADR-0046 (durable background in park mode).

`subagents(options)` adds the `agent` tool: the model delegates a self-contained task to another
agent, which runs as a **child session** (spec 05 §13) and returns a final report.

## 1. API

```ts
import {
  subagents, subagentChild, pendingSubagentApprovals, subagentWaitId,
  AGENT_TOOL, SEND_MESSAGE_TOOL, AGENT_OUTPUT_TOOL, AGENT_STOP_TOOL,            // default tool names
  AGENT_REPORT_MAX_CHARS, AGENT_MESSAGE_MAX_CHARS, AGENT_OUTPUT_PAGE_CHARS,     // 16 000, 8 000, 16 000
  AGENT_NAME_PATTERN, AGENT_MESSAGE_INSTRUCTIONS,
  SUBAGENT_NO_USER, SUBAGENT_NO_CLIENT, SUBAGENT_DENIED,                        // texts
} from 'eharness/subagent'

subagents({
  agents: Record<string, { agent: HarnessAgent; description: string; maxTurns?: number; resumable?: boolean }>
        | (() => Record<string, …>),          // evaluated once per session
  toolName?: string                            // 'agent'
  maxDepth?: number                            // 2: the root is depth 0; a session at maxDepth has no tool
  maxConcurrent?: number                       // 8, per nesting depth and plugin instance
  maxChildren?: number                         // no cap; children one session may start in total (§2.3)
  childSession?: (info: SubagentChildInfo) => Omit<SessionOptions, 'parent'> | undefined  // §2.4
  parentSession?: (sessionId: string) => Omit<SessionOptions, 'parent'> | undefined       // §2.4
  // tools (one pattern: `false` removes the tool, `{ name }` renames it)
  messageTool?: boolean | { name?: string }    // true: send_message + the `name` field of `agent` (§5); false removes both
  outputTool?: boolean | { name?: string }     // agent_output (§5.7): on when background or messageTool is on; true / { name } forces it on
  stopTool?: boolean | { name?: string }       // agent_stop (§5.8): same default as outputTool
  maxReportChars?: number                      // 16 000: cap of a background report (§2.2)
  messageLimits?: { perWindow?: number; windowMs?: number; duplicateWindowMs?: number; maxQueued?: number }   // §5.4
  background?: boolean | { default?: boolean; inChildren?: boolean }   // false; all strategies, durable in 'park' (§2.2, §3.5)
                                               //   true: run_in_background offered, foreground unless asked, root session only
                                               //   default: omitted run_in_background runs in the background (default false)
                                               //   inChildren: also offered in child sessions (default false)
  approvals: 'inline' | 'park' | 'policy'
  answer?: (request: SubagentApprovalRequest, signal: AbortSignal)
            => Promise<SubagentApprovalAnswer> | SubagentApprovalAnswer   // required for 'inline'
  policy?: 'deny' | 'approve'                  // 'policy': default 'deny'
  childSessionId?: (parentSessionId: string, toolCallId: string) => string   // `${parent}:agent:${toolCallId}`
  parkTimeoutMs?: number                       // 'park': timeout of the parent's wait (default none)
  parentAgent?: () => HarnessAgent             // see §3.1 (the agent is itself a child of a 'park' parent)
  selfAgent?: () => HarnessAgent               // this agent: 'park' reconciles waits on open (§3.4) and rebuilds its directory from storage (§5.9); other strategies rebuild names / finished agents (§5.6)
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

`subagents()` throws `TypeError` for `'inline'` without `answer`. `background` is allowed with `'park'`
(§3.5).

The tool-name constants match the tool names (`AGENT_TOOL` `'agent'`, `SEND_MESSAGE_TOOL`
`'send_message'`, `AGENT_OUTPUT_TOOL` `'agent_output'`, `AGENT_STOP_TOOL` `'agent_stop'`); the limit
constants sit next to them (`AGENT_REPORT_MAX_CHARS`, `AGENT_MESSAGE_MAX_CHARS`,
`AGENT_OUTPUT_PAGE_CHARS`). The status words are the task registry's everywhere: `'running' |
'completed' | 'failed' | 'stopped'` (`data-subagent.run` also has `'waiting'`).

## 2. The tool

Input `{ subagent_type, description, prompt, run_in_background? }`. `subagent_type` is an enum of the
catalog keys, so an unknown type is an invalid tool call the model corrects. `run_in_background`
exists only with `background`. The description lists the types (resolved once per session, so
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
status: 'running' | 'completed' | 'failed' | 'stopped' }` so a UI can open the child transcript after a reload.

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

### 2.2 Background (`run_in_background`; `'inline'` / `'policy'` here, `'park'` in §3.5)

With `background: { default: true }` an `agent` call that omits
`run_in_background` runs in the background, like Claude Code's interactive default; the field's
description tells the model to pass `false` only when it needs the result before continuing.
Default `false`: omitted means foreground.

The call returns at once with `Started background subagent <task id> (<type>): <description>. You will
be notified when it finishes.` The task id is the `subagentTasks` registry id (`agent-1`, …), the
same id the UI and the completion notice use. The child runs detached (concurrency cap applies, aborted when the
parent session closes) and on completion the plugin calls `ctx.session.inject('eh.event', { name:
'subagent', text, data: { sessionId, agent, status, taskId, name? } }, { deliver: 'next-step', wake: true })`: a
running parent sees it at its next step boundary, an idle one wakes. The event is a stored message,
so it survives restarts of the UI process. `text` starts `Background subagent <task id> ["<name>"] (<type>:
<description>) finished.` (`Resumed subagent …` after a resume, `failed` / `was stopped`), then the report; it
names the task id and agent name, never the child session id (that stays in `data`). The report is capped at `maxReportChars` (default `AGENT_REPORT_MAX_CHARS`, 16 000); a cut report ends `… [report cut at N of M characters; read the full report with agent_output({ id: "agent-2" })]` (without the hint when `agent_output` is off). An inject that
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
  moveToBackground(toolCallId?: string): string[]   // move running foreground agent calls to the background
}
```

`stop(id)` marks the task `stopped` first, then aborts the child (the abort signal of its turn);
the parent receives the `eh.event` with `data.status: 'stopped'` and a text that says it was
stopped (a stopped child counts as `failed` in the part). An id that is not a task of this
process is taken for a child session id: the plugin calls `requestAbort('stopped')` on it through
the catalog agents (spec 05 §9.1), which reaches a child running in another instance. Closing the
parent session stops every running task (`dispose`).

**Moving a foreground run to the background.** With `background` on (same rules as
`run_in_background`: root session, or `background.inChildren`; `'inline'` and `'policy'`, not
`'park'`, where it is a no-op) `subagentTasks.moveToBackground(toolCallId?)` detaches the running
foreground `agent` calls (Ctrl+B in Claude Code) and returns the new task ids (`[]` when none).
The tool call resolves at once with `Subagent moved to the background as task <id> (<type>):
<description>, by the user. Progress so far: <latest text or tool> You will be notified when it
finishes.`; its progress stream ends with a final `Moved to the background.` progress value and
that output. The child keeps running with its own abort controller: the tool call's abort signal
no longer reaches it (stop it with `stop(id)`), parent session close still aborts it. Completion
follows the background path above (task `agent-<n>`, `eh.event` report, `wake`, usage added to the
parent turn when it is still open, concurrency slot released at the end).

**Persisted marker.** The tool writes `data-subagent.run` `{ toolCallId, sessionId, agent,
status: 'running' }` (id = tool call id) when the background child starts. The final `completed` /
`failed` / `stopped` is written with the same id only while the starting turn still streams; afterwards the
report event (`eh.event`, `data: { sessionId, agent, status }`) is the durable record, since a
stored message of an earlier turn cannot be amended.

**Children of children (the rule).** A report is injected into the session that started the
child. A child session closes when its turn ends, which aborts its background children
(`ctx.signal`), so a nested background run would be lost. Rule: `run_in_background` is only
offered in sessions **without a parent** (the root the user sees); `background: { inChildren: true }`
offers it in child sessions too, for apps whose child sessions stay open (the report then goes to
that child). No cross-session injection exists (the root session handle lives in another agent
and may be in another instance). Shell background tasks follow the same rule by configuration:
install `shell({ background: true })` only on the root agent and a `shell()` without `background`
on child agents (spec 19).

### 2.3 Spawn cap (`maxChildren`)

`maxConcurrent` bounds children running at once; `maxChildren` bounds how many a session may
**start in total**, counted per parent session (a root and each child have their own budget of
children). A new `agent` call over the cap starts nothing and returns `ERROR: this session already
started N subagents and may not start more (limit M). …` (a model-readable string; for `'park'` it
resolves the wait at once). Resuming a finished child, messaging it and a redispatched start of the
same call are not new children (counted by child session id). Count source: `'park'` with
`selfAgent` reads the stored child index through `peek().children()` (so it holds across
instances and restarts, up to the 500 entries of `core.children`); otherwise the children this
session object started (inline / policy / background children do not outlive the process).

**Budgets per workspace.** Cost limits are not a plugin feature: the ledger (spec 12 §4.1) takes
app-defined scopes, so scope by workspace from the runtime, e.g. `budget.ledger.scopes: (ctx) =>
[`workspace:${ctx.runtime.workspaceId}`]`, and pass the same `runtime` to children with
`childSession` (§2.4) so child turns reserve against the same workspace scope. The ledger's
periods (monthly USD) are those of the adapter; a per-run or per-day cap is a scope the app names.

### 2.4 Session options of children (`childSession`, `parentSession`)

Every child session the plugin opens (foreground, background, park start, resume, `agent_stop` and
message delivery, the reconcile on open) is opened with `childSession({ parentSessionId, agent,
name?, depth })` merged under the plugin's own options (`parent`, the directory `runtime` key):
return `lock`, `runtime` (merged key by key), `storage`, `toolsContext`. `parent` cannot be
overridden. Hooks inside the child see `ctx.session.parent` with `agent`, `name` and `description`
(`ParentInfo`, spec 05 §13) and its own `ctx.runtime`. `parentSession(sessionId)` does the same for
the parent / root sessions opened from a child or by the plugin (`parentAgent`, `selfAgent`);
`subagentChild({ parent, parentSession })` has the same option. Reads of children and parents
(`agent_output`, park status, directory rebuild, `pendingSubagentApprovals(session, agent)`) use
`agent.peek()` (spec 05 §2.2): they never run `session.start` hooks of the session they read.
`pendingSubagentApprovals` entries carry `agent`, `name`, `description` of the child when stored.

## 3. `'park'` (profile c): nested approvals, ADR-0035

The tool is an `externalTool()` (spec 11 §4.2): a tool **without `execute`**, so the parent turn
always stops `'tool-pending'` at the call, with an external wait `w_<toolCallId>`. No progress
(preliminary outputs); background calls are answered at once and run durably (§3.5).

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
- Timeout: `parkTimeoutMs` (the wait's own timer / inbox timer / `expireWaits()`, ADR-0027); the default
  `onTimeout` is `WAIT_TIMED_OUT`. A report after a timeout is `already-resolved` and ignored.
- A `start` precondition failure (unknown type, no turn) resolves the wait at once with an `ERROR:`
  text through an immediately due `onTimeout`.
- A crash after the child finished and before the hook's `resolveWait()` is healed by
  `reconcileSubagentWaits` (§3.4); without it the wait stays parked until `parkTimeoutMs` or a manual
  `resolveWait`, so set `parkTimeoutMs` in production anyway.
- The concurrency slot is held while `start` awaits the child's first turn, not while parked.

### 3.3 Server recipe

```ts
const main = defineHarnessAgent({ ..., plugins: [subagents({ agents: { worker: { agent: worker, description } }, approvals: 'park', parkTimeoutMs: 3_600_000 })] })
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

### 3.5 Durable background children (`background` with `'park'`, ADR-0046)

`run_in_background: true` (or `background.default`; root session, or `background.inChildren`) makes
the call a **background start**; a call without it stays the foreground external wait above.

- **Start.** The tool's `start` (after the commit) opens the child with `parent`, awaits `ready()`
  (child index registration, spec 05 §13) and calls `child.enqueue(prompt, { mode: 'queue', id:
  'subagent-bg:<toolCallId>' })` (spec 05 §12 rule 17: idempotent; a child that already has messages
  is not enqueued again). The instance that holds the child drains the inbox and runs the turn
  (the enqueuing instance by default, any other after a restart / sweep). `maxTurns` is not applied.
- **Answer.** `start` returns an already-due `onTimeout` `{ output: 'Started background subagent
  <id> ["<name>"] (<type>): <description>. You will be notified when it finishes.' }` and payload
  `{ childSessionId, agent, description, status: 'running', background: true }`; the wait resolves
  at once and the parent turn continues in the same message. `<id>` is the child session id (no
  in-memory task ids in park mode). The parent turn is `tool-pending` only for that short window,
  in which a user message can still be denied (`WAIT_CANCELLED_NEW_INPUT`); the child already
  runs and reports. `reconcileSubagentWaits` skips these waits (payload `background: true`).
- **Report.** `turn.start` of the child's plugin (`subagents()` with `parentAgent`, or
  `subagentChild()`) stores a flag in the child's plugin state when the turn's inbox key is the
  `subagent-bg:` key. Every later turn end of that session, in any instance, then calls
  `parentAgent().session(<core.parent>).inject('eh.event', { name: 'subagent', text, data: {
  sessionId, agent, status, taskId, name? } }, { deliver: 'next-step', wake: true })`. `text`:
  `Background subagent <id> ["<name>"] (<type>: <description>) finished.` (`failed`, `was
  stopped` for an aborted turn), then the report capped at `maxReportChars` (cut hint names
  `agent_output`); `data.taskId` is the child session id. A turn that stops `tool-pending` sends the
  same event with `status: 'waiting'` and **no `wake`** (the child waits for a person; the lead
  reads it at its next turn). A turn the launcher started with a `relation="launcher"` frame
  reports as `Resumed subagent …` (§5.9).
- **Marker.** A `step.end` hook writes `data-subagent.run` `{ toolCallId, sessionId, agent, status:
  'running', name?, background? }` for every `agent` call in park mode (foreground and background),
  using the deterministic child id. The stored message is not amended later: the current status is
  read from the child (`children()`, `peek(child).stats()`), the report event (`data.status`) and
  `agent_output`.
- **Limits.** `maxChildren` as in §2.3. `maxConcurrent`: a start counts the session's children
  with an active turn or pending state from storage (newest 100, only when the index holds at
  least `maxConcurrent` entries; needs `selfAgent`) and answers `ERROR: N background subagents are
  already running (limit M). …` instead of starting; not enforceable across instances without a
  shared counter (best effort). The child's usage is not added to the lead's turn.
- **Tools.** `agent_output`, `agent_stop` (`requestAbort('stopped')`, cross-process; a child waiting
  for an approval refuses) and `send_message` work as in §5.9.
- **New user input.** Foreground waits are still cancelled by a new user message under
  `onNewInput: 'deny'` (spec 11 §4.1); delegate in the background to keep the lead free.

**Orphaned foreground parks (ADR-0046 amendment).** A foreground park child keeps running when its
parent call was answered without it: `onNewInput: 'deny'` (`WAIT_CANCELLED_NEW_INPUT`, spec 11 §4.1)
or an `Interrupted:` result (ADR-0014). When such a child's turn ends and the parent has no open wait
for `w_<toolCallId>`, the child's hook reads the parent's stored call (`output-error` with one of
those texts) and reports like a durable background child: the same `eh.event` (`deliver:
'next-step'`, `wake: true`), head `Background subagent <id> ["<name>"] (<type>: <description>)
finished after its call was cancelled.`, and it sets the background flag in its plugin state so a
`tool-pending` stop sends the `waiting` status event and later turns report too. A wait that was
resolved normally (or by `reconcileSubagentWaits`) does not report again.

## 4. Multi-instance and restarts

Everything the strategy needs is stored: the parent's pending wait, the child's pending state, the
parent / child index (`core.parent`, `core.children`). A restart between the park and the answer loses
nothing; the answering instance opens the child (and, through the hook, the parent) from storage.
`'inline'` keeps the child only in process; `'policy'` never parks.

## 5. Agent messaging (`send_message`, names, resume), ADR-0038 (Draft)

> **Draft / experimental (0.7).** `send_message`, named agents, resume, the roster reminder and the
> `<agent-message>` frame may change in a minor release
> ([API stability](../engineering/api-stability.md)).

Offered with every `approvals` strategy and `messageTool !== false` (default). A session that
has the plugin gets `send_message` even without a catalog or at `maxDepth` (leaf agents need it to
report to `main`); a child agent installs `subagents({ agents: {}, approvals: 'policy' })` for it.
The sections below describe `'inline'` / `'policy'` (an in-process directory and closures); with
`'park'` the directory comes from storage and delivery goes over the durable inbox: §5.9, ADR-0041.

### 5.1 Names and addressing

`agent` gains `name?: string` (`AGENT_NAME_PATTERN` `^[a-z0-9][a-z0-9-]{0,31}$`; `main` and
`agent-<n>` are reserved). Names are unique among every agent the root session knows, running or
finished; a collision or bad name yields an `ERROR:` string result (a pattern mismatch is an
invalid tool call). Targets (`to`): `main`, a task id (`agent-2`), a child session id, a name. A
foreground child is addressable too (by name or child session id; it has a task id only once moved
to the background or resumed). `SubagentTask` gains `name?`; `subagentTasks.get` also takes a name.

### 5.2 The tool

`send_message({ to, message })` (≤ 8 000 characters). Result strings: `Message delivered to <to>. …`,
`Message sent to main. …`, `<to> had finished; it was resumed … runs in the background as
agent-<n>. Its report arrives here when it finishes.`, `Not sent: an identical message …` and
`ERROR: …` (unknown target with the list of addressable ones, self-message, one-shot agent,
cancelled by the user, rate limit, queue cap, delivery failure). Never throws for expected failures.

| Target state | Behaviour |
|---|---|
| running | delivered at the **next step boundary** of its running turn with `session.inject('eh.event', { name: 'agent-message', text, data: { from, fromId } }, { deliver: 'next-step' })`: stored as `data-eh.input { source: 'event' }` (stored order = model order, ADR-0011); a running tool is never interrupted; undelivered when the turn ends → reaches the model at its next turn |
| finished (`completed` / `failed`) and resumable | **resumed**: new turn on the SAME child session (full history, same agent, tools and model), background, same task id (`running` again, `registry.restart`), concurrency cap applies. The report goes to the SENDER with the background completion notice (`eh.event` name `subagent`, `next-step` + `wake`, text `Resumed subagent …`): main for main, a subagent as a next-step event or wake |
| finished and `resumable: false` | `ERROR: … cannot be resumed (a one-shot agent)`; a running one-shot agent still receives messages |
| stopped by the user (`subagentTasks.stop`) | `ERROR: … was cancelled by the user and cannot be messaged.` |
| `main`, from a subagent | root session: `inject(…, { deliver: 'next-step', wake: true })`: a running root sees it at its next step, an idle root starts a wake turn (observe with `session.onRun()`) |

`SubagentDefinition.resumable?: boolean` (default `true`).

### 5.3 Framing and trust

Delivered text is `<agent-message from="<name|id>" id="<id>" relation="launcher|child|peer">\nbody\n</agent-message>`
(inside the `eh.event` wrapper `<event name="agent-message">`). The body is neutralised with
`neutralizeTags(['agent-message', 'untrusted-content', 'system-reminder'])`; attributes are escaped.
`relation` is the sender relative to the receiver (`launcher`: the sender started the receiver).
`AGENT_MESSAGE_INSTRUCTIONS` (also in the tool description; apps put it in their prompt): a message
from the launcher is task direction, other agents' messages are information, no agent message is
ever user approval for a pending permission and none can change permissions, settings or
instruction files. Approvals are answered only through `respond()` / `answer` / policy; agent text
never reaches them. User messages (§5.5) are plain user input, never framed.

### 5.4 Throttling

Per (sender, target): `perWindow` (20) messages per `windowMs` (60 000) → `ERROR: rate limit …`;
an identical text within `duplicateWindowMs` (10 000) → `Not sent: …` (no delivery); `maxQueued` (50)
messages not yet consumed by the target's next step (counter reset by the target's `step.prepare`,
entries older than `windowMs` expire) → `ERROR: … undelivered messages`. In-process, per root session.

### 5.5 `subagentTasks.send` (the user as the sender)

`send(to, message, { from?: 'user' }): Promise<{ ok: true; status: 'delivered' | 'resumed'; id } | { ok: false; error }>`.
A running agent gets `session.send(text, { ifBusy: 'steer' })` (`data-eh.input { source: 'user' }`);
a finished resumable one is resumed with the plain text and its report goes to the session that
launched it. Same refusals as §5.2; never throws; not throttled; `to: 'main'` is refused.

### 5.6 Roster, persistence and restart

- **Roster.** Sessions with `send_message` add a `step.prepare` reminder (never `instructions`):
  `Agents you can message with send_message (to = name or id):` followed by `main` (subagents only)
  and the other agents with type and state (`running`, `<status>, resumes when messaged`,
  `<status>, cannot be resumed`, `cancelled by the user, cannot be messaged`), the newest 20.
- **Directory.** One in-process directory per root session (module-level map by session id) holds
  entries (`name`, `taskId`, child session id, owner, status, `deliver` / `resume` closures created
  by the launching plugin). A launcher registers each child under the child's session id, so the
  child's own plugin instance finds it. Dropped when the root session closes.
- **Run marker.** `data-subagent.run` gains `name?` and `taskId?`; the completion `eh.event` data
  gains `taskId` and `name`.
- **Rebuild.** With `selfAgent`, the first step (or an unknown target) of a session reads
  `children()` and the last ~1 000 messages: markers give name / task id / agent type, completion
  events give `completed` / `failed` / `stopped` (a user stop stays refused); a marker still
  `running` is settled from the child's stored last stop. Rebuilt entries are resumable with their
  old ids (the id counter moves past them) and join `subagentTasks.list()` only once resumed. A
  child that was running at the restart is gone (rebuilt as `failed`).

### 5.7 `agent_output`

`agent_output({ id, offset?, limit? })` (name: `outputTool.name`; kind `safe` in `eharness/permissions`)
returns the full final report of an agent by task id, name or child session id: the last
non-empty text of the child session's stored assistant messages (after the last `step-start`, the
same extraction as the report), so it works after a restart and for one-shot agents. Pages of
`limit` characters (default 16 000) from `offset`; a longer report ends `… [characters A-B of N;
more: agent_output({ id: "…", offset: B })]`. A running agent returns `<label> (<type>) is still running;
no final report yet.` with its latest progress. Errors (`ERROR: no agent "x". Known agents: …`) are
strings. Offered when `background` or `messageTool` is on (`outputTool: false` disables it, `outputTool: true` forces it on). The tool reads the child through a short-lived session handle and closes it afterwards only when the child is idle: it never closes a child that is running or was resumed meanwhile (checked again after the read).

### 5.8 `agent_stop`

`agent_stop({ id })` (name: `stopTool.name`; kind `safe`; offered with `agent_output`'s condition,
`stopTool: false` disables it) stops a running background agent by task id, name or child session
id, like `subagentTasks.stop`. Unlike a user stop, a model stop leaves the agent resumable (unless
its type is one-shot): the entry keeps `modelStopped`, so `send_message` resumes it. User stops
still refuse. Results: `Stopped <label>. It can be resumed by sending it a message.`,
`<label> is not running (<status>).`, `ERROR: no running agent "x". …`. The `kill_shell` unknown id
error points to it.

### 5.9 `'park'` mode (ADR-0041)

Same tools, names (`agent.name`), framing (§5.3), throttling (§5.4) and `AGENT_MESSAGE_INSTRUCTIONS`;
different mechanism, because a park child may run, wait or be answered in another instance.

- **Directory.** A session addresses its **own children** and `main`; no task ids (an agent is a
  name or a child session id, the frame `id` is the child session id), no sibling messaging.
  Rebuilt from storage with `selfAgent`: `children()` joined with the stored `agent` tool inputs
  (`subagent_type`, `description`, `name`). Throttled (15 s for the step reminder, 500 ms on a
  miss); the `agent` call also registers its child at once and checks the `name` against the
  rebuilt directory. Entries are `durable`: no closures, state read from the child when needed.
  The roster reminder lists them as `a running agent gets the message, a finished one resumes`.
- **Delivery.** `childSession.enqueue(framed, { mode })` (spec 05 §12): `'steer'` for a child with
  a live turn (next step, stored as `data-eh.input` with `source: 'user'`, the body is the frame);
  `'queue'` for an idle / finished child (a new turn on the same session, by whichever instance
  holds it) and for a child waiting for an approval (held until it is answered, rule 8).
  `resumable: false` refuses a finished child. The frame carries `to="<receiver label>"`
  (`relation="launcher"`: only a launcher messages its children).
- **Report of a resumed child.** The child's `turn.end` hook (`subagents()` with `parentAgent`, or
  `subagentChild()`) sees a first user message that is a `relation="launcher"` frame with `to` and
  calls `parentAgent().session(<core.parent>).inject('eh.event', { name: 'subagent', text:
  'Resumed subagent … finished.\n\n<report>', data: { sessionId, status, name? } }, { deliver:
  'next-step', wake: true })`. The target is the stored parent, never read from the frame. A resumed
  turn that stops `tool-pending` reports nothing automatically.
- **To `main`.** `parentAgent().session(rootId).enqueue(framed, { mode: 'queue' })` (`'queue'`: a
  steer meeting a `tool-pending` root is dropped, spec 05 §12 rule 7); `rootId` is found by walking
  the stored parent links with `parentAgent`. Without `parentAgent` the tool answers `ERROR: the main
  agent cannot be reached …`.
- **`agent_output`** reads the child's stored messages. **`agent_stop`** is `requestAbort('stopped')`
  on the child (a child waiting for an approval refuses); a stopped agent stays resumable (a user
  stop is not distinguishable in storage).
- **Needs** `storage.inbox` for cross-instance delivery, `selfAgent` for names and rebuilt
  agents, `parentAgent` on child agents. Not applied in park mode: `maxConcurrent` for resumes,
  usage of a resumed run in the sender's turn, shared throttling counters.

## 6. Model-visible texts (a change is a minor change)

Tool description (see source `toolDescription`), `SUBAGENT_NO_USER`: "No user is available; this
action is not allowed in autonomous mode.", `SUBAGENT_NO_CLIENT`: "No user is available to answer
this call. Continue without it or choose another approach.", the final output forms of §2.1 and the
background event text, the `Subagent moved to the background as task …` result and everything in §5 (tool description, result strings, `AGENT_MESSAGE_INSTRUCTIONS`, the roster reminder), the `agent_output` description, result strings and the cut notice.

## 7. Tests

`src/subagent/subagent.test.ts`: inline approve / deny with feedback / client tool, policy
deny / approve, child error, abort propagation, depth limit, per-depth concurrency, background wake,
park (another instance answers; parent process restart; child finishes at once; child fails),
`reconcileSubagentWaits` (child finished without the hook, still waiting, `selfAgent` on open),
`pendingSubagentApprovals`, `subagentTasks` (list / tail / stop / `run` part), `background.inChildren`.
`src/subagent/park-messaging.test.ts`: two instances over shared storage (park on a child, answer it from the other instance, message the finished agent by name, report reaches the parent), steer into a running child, child to main, throttling, refusals, `agent_stop`.
`src/subagent/background-park.test.ts`: durable background start (answered at once, marker with the child id, a user message not cancelled, approval answered from another instance, report wakes the parent), an instance that cannot claim the child (B drains the inbox and reports), a close mid-turn (stopped report), `agent_output` / `agent_stop`, foreground unchanged, `background.default`.
`src/subagent/messaging.test.ts`: running target (`data-eh.input`, model order), resume with full history and the report to the sender, subagent → main wake, subagent → sibling, user-stopped refusal, one-shot refusal, unknown target, name collision / validation, throttling and queue cap, spoofed tags, `subagentTasks.send`, roster, `messageTool: false`, tool options (`{ name }` / `false`), agent directory isolation between two agents that reuse a session id, rebuild after reopening the root session.
`src/subagent/child-session.test.ts`: `childSession` / `parentSession` options and identity on `ctx.session.parent`, `maxChildren`, identity in `children()` / `pendingSubagentApprovals`, `peek` use.
Core: `src/session/context-inject.int.test.ts` (`ctx.session.inject`), `src/session/peek.int.test.ts` (`agent.peek`).
