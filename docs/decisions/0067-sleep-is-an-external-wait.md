# ADR-0067: `sleep` is an external wait

Status: **Accepted** · Date: 2026-11-03 · Builds on: [ADR-0027](0027-external-waits-park-at-the-tool-boundary.md), [ADR-0046](0046-durable-background-subagents-in-park-mode.md)

## Context

Work that must be spread over time (send 700 follow-ups in batches, poll a slow job, retry later)
had no good tool. An agent either promised to come back "every 30 minutes" and relied on a
heartbeat that runs on its own schedule (and, in the team app, may not send), or ran everything in
one turn without any pause. A coding agent solves this with a background worker that loops "do a
batch, `sleep`, repeat" in a shell. A harness turn cannot hold a process for minutes: the run would
keep a lock, a stream and memory alive, and a restart would lose it.

## Decision

- `eharness/clock` gets a `sleep({ minutes, reason? })` tool (`sleepTool()`, or
  `clock({ sleep: true })`). It is an `externalTool()` without outside work: `start` sets the wait's
  `timeoutAt` to the wake-up time and its `onTimeout` output to a wake-up text. The turn parks
  `tool-pending`; the session's wait timer, the inbox timer or `expireWaits()` (after a restart)
  continues it when it is due. Nothing runs and nothing is spent while it sleeps.
- Bounds: whole minutes from 1 to `maxMinutes` (default 240) per call, checked by the input schema
  (a tool error the model reads). The tool's own timeout is `maxMinutes`, so a wait whose `start`
  never ran still wakes. Loops are bounded by the app's step and cost budgets and by stopping the
  session, not by a sleep counter.
- New input to the session ends a sleep early (the usual rule for parked waits: the wait is
  cancelled, the model sees the new message).
  **Amendment (2026-11-04):** that rule holds for an explicit `send()` only; queued and inbox input
  is held while a session is parked, so a `send_message` to a sleeping park child waited for the
  whole sleep (hours in production, while the lead kept being told "delivered"). `send_message`
  now resolves the child's sleeps with a wake-up text that carries the message (spec 20 §5.9).
- A durable background child (ADR-0046) parked only on external waits (no approval or question a
  person must answer) no longer reports "waiting" to its parent: nobody has to act, so the parent is
  not woken for every sleep. It reports when it finishes, as before.

## Consequences

+ "Do a batch, sleep, repeat" works in any session, survives restarts and costs nothing between
  batches.
+ No new runtime dependency, no new storage: it reuses external waits.
− A sleep is as precise as the wait timer: about a second in a running process, the inbox poll or
  the next `expireWaits()` after a restart.
