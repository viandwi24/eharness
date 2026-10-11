# ADR-0058: Activity feed and attention queue as one subpath, `eharness/activity`

Status: **Accepted** · Date: 2026-10-11 · Builds on: [ADR-0008](0008-plugins-adapters-dogfooding.md), [ADR-0037](0037-fork-and-child-index.md), [ADR-0042](0042-peek-child-identity-spawn-cap.md), [ADR-0044](0044-partial-resolution-of-pending-approvals.md), [ADR-0056](0056-restart-recovery-and-background-reconcile.md)

## Context

The team example built, by hand and with several bugs, two things every multi-user harness needs:
an events table with SSE (a `taskIndex` plugin appending rows from hooks, a poll loop, a retention
mark, resync for old cursors, a boot id, keep-alives, `Last-Event-ID`) and a cross-session
approvals list with an idempotent answer (`ALREADY_ANSWERED` mapped from three different error
shapes, a busy re-check, a stale-answer interpretation). Each app would write them again.

## Decision

1. **One subpath, `eharness/activity`**, holds the feed (types, `activity()` plugin, `ActivityStore`
   port, memory adapter, SSE helpers) and the attention queue (`listAttention`, `answerAttention`).
   They share the store (`answerAttention` appends `attention-answered`) and the same consumers, and
   the attention code needs no import of `eharness/subagent` or `eharness/ask`: it reads the child
   index and the pending state through core `SessionPeek`. A second subpath would need an
   `allowedImports` exception for nothing.
2. **A plugin, not a new agent-level sink.** The lifecycle already has hooks; `activity()` maps them
   to events. The one gap was *after the save*: a new observe-only core hook, `message.saved`
   (`message.beforeSave` runs before the save, so an event could announce a message a reader cannot
   load yet). Recovery needs no hook: the repaired turn saves an `eh.notice` (`EH_TURN_INTERRUPTED`)
   that the plugin turns into `session-recovered`.
3. **The store is a port over free-form types.** `type` is a string, so the app's own events
   (`providers-changed`, `settings-changed`) live on the same feed and `seq` as the library's. The
   library types are documented and must not be reused with another payload. The port is async
   (SQL adapters, remote logs) and its retention semantics are normative: prune a **prefix**, never
   the newest record, a monotonic `prunedThrough`, optional `keepLatestOf` survivors (the team's
   "last message of every agent" rule, expressed generically).
4. **`pending-changed` carries a snapshot (`waiting`), not a diff.** Diffs need the previous state,
   which a hook does not have on another instance; a snapshot makes consumers idempotent. Items
   answered by a partial `respond()` are listed separately (`answered`).
5. **`child-reported` comes from the child's `turn.end`** (emitted on the parent session), not from
   the `eh.event` the background mode injects: it covers park, inline and background children alike.
6. **SSE is Web-API only** (`ReadableStream`, `Request`/`Response`), framework neutral. Resync rules:
   a cursor below `prunedThrough` or above the head gets one `resync` event; no cursor means "start
   at the head"; cursor `0` never resyncs (it asks for everything that is left).
7. **`answerAttention` is the one place the "already answered" mapping lives.** Statuses
   `resumed | recorded | already-answered | not-found` are results, not errors; real mistakes (wrong
   kind, invalid answer, a busy session with a waiting item, closed session, storage) throw.
   `already-answered` vs `not-found` is decided from the recent history of the session (a tool part
   with that approval / call id), so a repeated answer is idempotent instead of a 404. The answer is
   always sent to the owning session, never through the parent.
8. **External waits are opt-in in `listAttention`** (`waits`): a parent parked on a subagent is also
   an external wait, and nobody can answer it.
9. **`eharness/testing` may import `eharness/activity` for types** (`allowedImports`, like ADR-0049):
   `activityStoreConformance` checks a store the library's types describe.

## Consequences

- Apps stop writing hook-to-table plumbing and the answer/ALREADY_ANSWERED code; the team example
  deletes ~600 lines (see its migration notes).
- `message.saved` is a new hook name (additive; `wrapPlugin` and the hook registry accept it).
- A feed event is not a source of truth: sessions are. A consumer that misses events (resync) refetches state.
- `createdAt` of an attention item is the time of its assistant message (UUIDv7), not of the
  approval request; good enough to sort, documented as such.
