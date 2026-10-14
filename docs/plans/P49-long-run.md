# P49 — Long-run jobs: no "ran out of steps", hours of work, survives restarts

Status: done (2026-10-14). Owner: maintainer. Builds on [P47](P47-module-adoption.md).

## Why

A long job asked for in a company chat (an audit of a Telegram group over weeks) ended with "I ran
out of steps" in front of everybody. Today a turn has a fixed step cap (chat 120, task 200, worker
400 steps); at the cap the agent summarizes and stops, and a server restart marks a running turn
interrupted and never continues it. A coding agent such as Claude runs for many hours while it is
on track: it stops only when the job is done, when it is stuck, when a budget runs out or when a
person stops it.

## Design

1. **`longRun()`** (`eharness/limits`): a job runs as a chain of bounded turns (chunks). At the
   end of a chunk, while the job makes progress, the model writes a checkpoint note (what is done,
   what is next) and a continuation turn is enqueued on the durable inbox with an idempotent id. A
   job stops only when the model finishes (a turn without tool calls), when the progress guard says
   it is stuck, when its cost budget or wall-clock limit is spent, or when a person stops it. Job
   state (status, chunks, steps, cost, started, last checkpoint, stop reason) lives in session
   state; a reconcile call resumes a running job after a restart.
2. **`stepBudget({ onCap })`**: when a turn reaches its hard cap while it still makes progress, it
   gets a few extra steps and a reminder to hand the rest over (in the team: start the background
   worker with a complete brief and tell the chat it continues in the background) instead of the
   plain wrap-up.
3. **Team**: workers run as long-run jobs (no fixed 400-step cap; cost and duration limits by
   setting); chat, task and child turns hand over at their cap; running jobs resume at boot; the
   Tasks page shows a job's progress, cost, checkpoint and a Stop button. E2e: a chat audit longer
   than the chat cap is handed to the worker without any "ran out of steps" text; a worker job
   longer than 400 steps completes across chunks; a restart in the middle resumes it.
4. **Coder**: unlimited steps while on track (Claude-like), bounded by the progress guard and the
   existing interrupt.

## Work items

| # | Item | Wave | Status |
|---|---|---|---|
| W1 | Library: `longRun()`, `stepBudget({ onCap })`, reconcile and stop helpers, spec 33, tests incl. a simulated restart | 1 | done |
| W2 | Team: workers on `longRun`, hand-over at caps, resume at boot, Tasks progress and Stop, e2e scenarios | 2 | done |
| W3 | Coder: long-run while on track | 2 | done |

## Notes from the work

- W1: a chunk ends with the forced `long_run_checkpoint` tool (a text-only step always completes
  in core), the turn stops `plugin:long-run:checkpoint`, and `turn.end` stores the note and
  enqueues `longrun:<session>:<chunk>`. Background children skip checkpoint turns
  (`isLongRunCheckpoint`), so the parent gets one report. The background `timeoutMs` bounds one
  chunk; the job is bounded by `maxCostUsd` and `maxDurationMs`. Core fix: state changed by
  `turn.end` hooks is written after the hooks (spec 05 §7).
- W2: the team's workers run long jobs (chunk 80 steps, $10 and 24 h by default:
  `TEAM_LONG_RUN_MAX_COST_USD`, `TEAM_LONG_RUN_MAX_HOURS`, `TEAM_LONG_RUN_CHUNK_STEPS`;
  `TEAM_MAX_WORKER_STEPS` removed). Chat (120) and task/child (200) turns hand over to the worker at
  their cap (`onCap`), and the gateway never posts "ran out of steps": a turn that still stops at
  the cap wakes once to hand over (`handover:<trigger>`), with a neutral line only if that fails.
  Every reconcile pass resumes running jobs. The task page shows the job and has a Stop button
  (`POST /tasks/{id}/stop`). Fixed on the way: the checkpoint tool needed no approval, the
  delegating chat message survives a restart (`ch_meta`), the lock heartbeat no longer crashes on
  a closed database. E2E H-14..H-17.
- W3: the coder runs unlimited steps while on track by default (`--max-steps 0`).
