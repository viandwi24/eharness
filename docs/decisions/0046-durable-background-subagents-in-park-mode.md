# ADR-0046: Durable background subagents in `park` mode

Status: **Accepted** · Date: 2026-10-10 · Builds on: [ADR-0035](0035-nested-approvals-park-the-parent.md), [ADR-0038](0038-agent-messaging.md), [ADR-0040](0040-enqueue-timers-and-ids.md), [ADR-0041](0041-park-mode-messaging.md), [ADR-0042](0042-peek-child-identity-spawn-cap.md)

## Context

In `approvals: 'park'` every `agent` call is an external wait: the lead's turn parks until the child
finishes. Real use (the team example) showed the cost: while role agents work, any new user message
to the lead hits `onNewInput: 'deny'` (spec 11 §4.1), which cancels the open waits with
`WAIT_CANCELLED_NEW_INPUT`. The delegations are lost although the children keep running. Park mode
also stored no `data-subagent.run` marker (the tool body runs after the step ended), so a UI had
no child session id for the call. ADR-0035 recorded "no background in park mode"; Claude Code
shows what is missing: subagents run in the background, the lead stays free to talk and reports
arrive later.

## Decision

`subagents({ approvals: 'park', background })` is allowed (it used to throw `TypeError`).
`run_in_background: true` (or `background.default`) makes the call a **durable background start**:

1. `start` (the external tool's start, after the commit) opens the child with `parent`, awaits
   `ready()` (the child registers in the parent's child index, ADR-0037) and writes the first
   input to the child's **durable inbox**: `child.enqueue(prompt, { mode: 'queue', id:
   'subagent-bg:<toolCallId>' })`. Whichever instance holds the child drains it and runs the turn;
   nothing needs an in-process promise. The inbox key makes a redispatched `start` idempotent (and
   a child that already has messages is not enqueued again).
2. The wait is answered **immediately** from `start`: it returns an already-due `onTimeout`
   `{ output: 'Started background subagent <id> ("<name>") (<type>): <description>. You will be
   notified when it finishes.' }` and the payload `{ childSessionId, agent, description, status:
   'running', background: true }`. The parent's turn continues in the same assistant message as
   after any resolved wait. No new core API: the tool stays an `externalTool()`, because a tool is
   either `execute`-less (parks) or not, and one `agent` tool has to offer both foreground and
   background calls. The residual window (the milliseconds between the parked commit and the due
   timer) is the only time a user message can still be denied; the child is already running, its
   report still arrives, and the model then sees `Cancelled` instead of "Started" for that call.
3. The child's own approvals and questions stay its own pending state, answered with
   `child.respond()` from any instance (unchanged).
4. The child-side hooks (`turn.start` / `turn.end` of `subagents()` with `parentAgent`, or
   `subagentChild()`) recognise a background child: `turn.start` stores a flag in the child's own
   plugin state when the turn's inbox key is the `subagent-bg:` key, so later turns of that session
   (a `respond()` continuation in another instance) know too. When a turn of a flagged child
   ends, the hook calls `parentAgent().session(<core.parent>).inject('eh.event', { name:
   'subagent', text, data: { sessionId, agent, status, taskId, name? } }, { deliver:
   'next-step', wake: true })`, through storage: a running parent sees it at its next step, an
   idle one wakes, in any instance. Text and data follow the in-process background report
   (`Background subagent <id> "<name>" (<type>: <description>) finished.` / `failed` / `was
   stopped`, then the report, cut at `maxReportChars`). In park mode the id is the **child session
   id** (ADR-0041: there are no in-memory task ids). A child that stops `tool-pending` sends a
   status event (`status: 'waiting'`) **without** `wake`, so the lead can tell the user at its next
   turn without being started for it. A turn the launcher started with `send_message` keeps the
   `Resumed subagent …` report of ADR-0041.
5. **Marker.** A `step.end` hook of the plugin writes `data-subagent.run` `{ toolCallId, sessionId,
   agent, status: 'running', name?, background? }` (id = tool call id) for every `agent` call in
   park mode, foreground and background, while the step still streams. The child id is
   deterministic (`childSessionId`), so it is known before `start` runs. A stored message cannot be
   amended later: the **later status** lives in the child index and the child's stored state
   (`children()`, `peek().stats()`), in the report event, and in `agent_output`.
6. `agent_output`, `agent_stop` (`requestAbort('stopped')`, cross-process) and `send_message`
   (ADR-0041) work on these children unchanged: the directory is rebuilt from the index and the
   stored `agent` inputs.
7. `maxChildren` counts the stored index as before. `maxConcurrent`: a background start counts the
   children of the session that have an active turn or pending state (read from storage, newest
   100, only when the index holds at least `maxConcurrent` entries) and refuses with a readable
   `ERROR:` result when the cap is reached. It is best effort across instances: without a shared
   counter two instances starting at the same moment may both pass. Without `selfAgent` it is not
   applied.
8. **Foreground park** (no `run_in_background`) is unchanged: an external wait, cancelled by a new
   user message under `onNewInput: 'deny'`. We did not add a per-plugin option to keep waits open
   across new input: the cancelled call must still get a tool result before the model sees the
   next user message, and synthesising "still running" results for open waits would make the
   stored order differ from the model order (ADR-0011, ADR-0014). Applications that want a lead
   that stays free to chat use background delegation; the docs say so.

## Amendment: orphaned foreground parks

A foreground park child whose parent call was cancelled by new input (`WAIT_CANCELLED_NEW_INPUT`)
or answered `Interrupted:` keeps running, and its end found no wait to resolve, so the lead was
never told. Decision: when the child's turn ends and the parent's stored call for its `toolCallId`
is an `output-error` with those texts, it is treated as a background child (report through
`inject` with `wake`, flag set in its plugin state, `waiting` events). This is also the safety net
for the brief window above. Normally resolved waits are untouched.

## Consequences

+ The lead stays free to chat while role agents work; reports, approvals and restarts work across
  instances. Nothing new in the core; additive option, minor change.
+ Needs `storage.inbox` for cross-instance start (without it the child starts in the enqueuing
  process, as any `enqueue`), `selfAgent` for names / `maxConcurrent`, `parentAgent` on child
  agents (or `subagentChild`) for reports.
− `maxTurns` of the definition is not applied (an inbox turn uses the agent's `loop.maxSteps`);
  the child's usage is not added to the lead's turn; the enqueuing instance keeps the child
  session handle open (it drains the inbox); a crash of the instance running the child leaves
  the turn interrupted (recovery marks it, no `turn.end` runs there), so no report arrives: the
  lead finds it with `agent_output` / `children()`. A graceful close aborts the turn and reports
  it as stopped.
− The brief window described in 2.
