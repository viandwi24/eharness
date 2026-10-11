# ADR-0056: Restart recovery without waiting, and a reconciler for background children

Status: **Accepted** · Date: 2026-10-11 · Builds on: [ADR-0014](0014-interrupted-tool-calls-answered.md), [ADR-0046](0046-durable-background-subagents-in-park-mode.md), [ADR-0054](0054-held-wakes-while-pending.md)

## Context

A killed server left its turns `activeTurn` with a random per-process owner id: the restarted
process saw a "live foreign" turn until `recovery.staleMs` (120 s), so "continue" answered
`EH_SESSION_BUSY` and the chat looked stuck. Background children had the same hole in the other
direction: the report is sent by the child's `turn.end` hook, which a hard crash never runs; a child
whose first inbox item was never drained, or that waited for a person forever, never told the parent.

## Decision

1. `recovery.instanceId`: an optional **stable** id of the instance. A process that restarts with
   the same id owns the turns its previous run left active, so the existing rule "an `activeTurn`
   owned by this instance but not running here is stale" recovers them at the next operation. It
   must be unique among live instances of one storage (the team example uses `TEAM_INSTANCE_ID`, else `team-<port>`).
   Locks keyed by the same owner prefix may be taken over by the restarted instance (the example's
   SQLite lock does).
2. `session.recover()`: runs the recovery of spec 05 §9 now (dangling calls answered `Interrupted:`,
   open text parts closed, `stop: 'interrupted'`, `eh.notice`, `activeTurn` cleared) so an app can do
   it at boot for the sessions it knows, not at the next user message. Shared code with the commit
   point; idempotent. `attachRemote` ignores a log whose turn this instance id owns.
3. `inject({ key })`: an idempotency key stored in `metadata.eharness.key`, checked against the
   newest 200 stored messages. Reports use `subagent-report:<child>:<turn>`.
4. `reconcileBackgroundChildren(parent, options)` (also run at `session.start` of a root `park`
   parent, optionally every `background.reconcileEveryMs`): for each background child (marked by
   `data-subagent.run`) it recovers a dead turn, then delivers the missing report: ended turns
   (completed / failed / stopped / **interrupted**), "not started" after `startGraceMs`, "timed out"
   after `background.timeoutMs` (optionally stopping the child), and one reminder after
   `waitingReminderMs` when a child waits for a person. "Reported" is read from the parent (key, or
   a `subagent` event newer than the child turn, which covers reports of older versions). The hook
   retries delivery (3 attempts) and uses the same keys, so hook and reconcile never double-report.
   The status vocabulary of `data.status` gains `interrupted`, `timed_out`, `not_started`.

## Consequences

- Two instances reconciling at the same millisecond can still both save a report (best effort, as
  for `maxConcurrent`); the window is a few milliseconds and the second is a duplicate event, not a loss.
- Single-instance deployments should set `instanceId`; multi-instance ones keep the staleMs rule
  (or a lock takeover) for foreign owners.
