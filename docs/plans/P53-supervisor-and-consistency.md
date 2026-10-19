# P53 — Supervisor duty and consistency

Status: in progress · Owner: agent session · Branch: main

## Goal

Agents leave work half done in ways nobody sees: a run failed after its automatic retries and
nobody continued it, a decision waited a week, a connection broke, a memory file still names a
tool that was removed. After this phase the heartbeat of an agent supervises its own work with no
checklist line and no model call unless the server found something, and the consistency detectors
(part 2, written by the other agent: `domain/consistency.ts`, `app/consistency.ts`,
`consistencyFindings(deps, { agentId, now })`) feed it.

## Part 1 — the supervisor duty of the heartbeat

### What the server observes (every `schedule` beat, `app/supervisor.ts`, no model call)

For the agent's own work (`domain/supervisor.ts` `superviseObservation`):

| Item | When |
|---|---|
| `run-failed` | a task ended `failed` / `interrupted` / `timed_out` in the last 48 h (automatic retries are exhausted: a `retrying` task is never listed), and no later run of the same program finished fine |
| `run-stuck` | `running` with no activity for 2 h (a run parked on an open decision is not stuck), or `needs_action` for 6 h |
| `decision-waiting` | an open decision of the agent older than one day (the supervisor's own questions, titled `Supervisor: ...`, do not count) |
| `connection-broken` | a connection the agent uses is in `error` or `needs-auth` |
| `consistency` | `consistencyFindings(deps, { agentId })`, new or changed since a beat last saw them (fingerprint); the Monday deep review lists all of them |

An item is shown to a beat once per 24 h per fingerprint (`state.supervisor.seen`); the fingerprint
of a failed run also carries its failure class and retry verdict, so a changed verdict shows it
again. A beat with no checklist, no order and no item is skipped (`nothing to watch`, no model
call). With items but nothing else to watch the beat is a supervisor-only beat (a short prompt: the
list, the rules, the final answer). Deadline and activity beats do not supervise.

### Per item the beat decides (recorded as items of the beat log, with a reason)

- **retry** (`decision: 'retry'`, tool `heartbeat_retry_run { task, reason }`): continues the run
  through the existing path (`retryTask`, the same as `POST /tasks/{id}/retry`). The server refuses:
  another agent's run, a run that did not fail, a run the supervisor already retried (it failed
  again: escalate), more than 3 retries per agent per local day, and a failure a retry cannot change.
- **escalate** (tool `heartbeat_ask_owner { title, diagnosis, fix, options? }`): one Decision Center
  `escalation` titled `Supervisor: <agent>: <title>`, one open question per title, 5 a day per
  agent. It changes nothing by itself. The beat also lists it with `decision: 'escalate'` (bell).
- **note**: `heartbeat_note`.

Failure classes (`classifyRunFailure`, from the text the task stored): `transient` and `unknown` may
be retried; `auth` only when none of the connections the agent uses is in error now (the cause is
shown gone); `denial` (denied, outside authority, permission, declined) and `permanent` (budget,
context, content, provider rejected the request) never: escalate with the concrete fix, e.g.
"propose a change to program X adding tool Y" (the beat has `propose_plan { program }`, or asks
with `heartbeat_ask_owner`).

### Memory of the agent itself

A beat whose list has memory findings of the agent's own memory (`memory-dead-ref`,
`memory-duplicate-topic`, `memory-placeholder`, `memory-system-state`) gets
`state.supervisor.memoryFix` for that beat only. The heartbeat gate (`agent-factory` heartbeat
branch, `memoryCallRefusal`) then allows:

- `memory_view`: always, only under `/memories/agents/<id>/`;
- `memory_create`, `memory_str_replace`, `memory_insert`, `memory_delete`, `memory_rename`: only
  while `memoryFix` is on, only under that folder (also the target of a rename), never
  `HEARTBEAT.md` (the standing orders), no `..`.

The prompt tells the beat to keep facts that are still true, merge two files on one topic into one
(delete the other), remove volatile system state and placeholders, and replace a stale tool or
program name only after verifying it with `runs_list`, `run_read`, `session_read` or the program
list (never invent one). Every edit is recorded at `tool.after` (`state.supervisor.memoryChanges`);
`finishBeat` turns each file into an item of kind `supervisor.memory-fix` in the beat log (the
beat's own item for the file carries the reason; otherwise the server writes one) and the daily
digest prints ONE line for all of them ("Memory cleaned up by the supervisor: N files"). Findings
about programs, standing orders, routines, decisions or connections are never edited by the beat:
it asks the owner with the concrete action, or `propose_plan` with `program` for a program.

### Weekly deep review

On the first `schedule` beat of a Monday (team timezone, `state.supervisor.deepWeek`) the
observation lists every consistency finding even if nothing changed, and the beat writes one
`heartbeat_note` ("consistency report", evidence a `/memories/...` or `/library/...` path) of what
it fixed and what waits for the owners. With no finding and nothing else to watch there is no
model call and the week is marked done. `heartbeat_note` evidence now also accepts `/memories/...`
paths.

### Changes

- `domain/supervisor.ts` (new, pure): classification, `retryVerdict`, observation, prompt steps,
  memory gate.
- `app/supervisor.ts` (new): `supervise`, `retryRun`, `askOwner`, memory change record.
- `domain/heartbeat.ts`: `BEAT_DECISIONS` gains `retry`; `HeartbeatState.supervisor`; the two tools
  in `HEARTBEAT_ALLOWED`; `beatPrompt` takes `supervisor` blocks and `supervisorOnly`; the digest
  groups memory edits.
- `app/heartbeat.ts`: `beginBeat` supervises and no longer skips on an empty checklist when there is
  an item; `finishBeat` adds the memory-edit items.
- `infra/eh/heartbeat-plugin.ts`, `main.ts`, `agent-factory.ts`: the tools, the `tool.after` hook,
  the gate.
- HTTP: `BeatItem.decision` has `retry` (openapi and web types regenerated; the Heartbeat tab shows
  "Retried").

### Checklist (part 1)

- [x] observation, classification and retry rule (own runs, 3 a day, never twice, never for a denial)
- [x] tools `heartbeat_retry_run`, `heartbeat_ask_owner`; decision `retry` in the beat log
- [x] memory edits of the agent's own memory in the gate; beat log item and one digest line
- [x] weekly deep review
- [x] no model call when there is nothing to do
- [x] tests: `test/supervisor.test.ts`

### Open questions

- Classification reads the stored task summary; a denial that the run reports in its own words may
  be classified `unknown` and offered for retry. The retry stays capped (once per run, 3 a day).
- A run stuck `running` is only reported (retry needs a failed task); abort is not offered to the
  beat.
- The beat edits memory through the model; a bad edit is visible in the beat log but is not rolled
  back automatically.
- [x] `heartbeat_ask_owner` takes a structured `action` (`retry-run`, `pause-routine`,
  `remove-order`, `propose-program-tool`, `fix-finding`) instead of free options: the server checks
  it is possible now, offers it and "Leave it", carries it out when the owner picks it
  (`app/answer-actions.ts`, through `orderActions`), and records the outcome on the decision. Free
  options stay answers for the agent to read.
- [x] Health one-click fixes (`app/consistency-fix.ts`, `POST /agent-health/findings/{fingerprint}/fix`,
  `fixAction` on the finding, confirmation on the page): un-forbid a granted tool, delete the
  duplicate program or routine that has no runs (both none: the identical newer copy), remove the
  order that repeats a program note. The server re-scans and re-plans on every click; other findings
  keep their text fix.
