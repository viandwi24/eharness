# ADR-0069: A turn knows who asked for it (`principal`)

Status: **Proposed** · Date: 2026-11-08 · Plan: [P62](../plans/P62-adopter-gaps.md) · Builds on: [ADR-0056](0056-restart-recovery-and-background-reconcile.md)

## Context

A turn has no durable notion of who asked for it. The nearest things are:

- `SessionOptions.runtime` / `SendOptions.runtime`, exposed as `ctx.runtime`. It exists only in the
  process that opened or sent it. Inbox `send` items carry parts, a client id and app metadata
  (`SerializedInput`), not runtime. A turn drained on another instance, woken by the scheduler,
  recovered after a crash, or continued after a park runs with whatever runtime that instance holds.
- `ApprovalActor` (`{ id, name?, … }`), which records who **answered** an approval, not who asked.

Apps work around it by encoding the person in the session id (Keith derives the person from
`front:<id>` in hooks that have no other source) or in app metadata. Both break for shared
sessions (group chats, where one session has many people) and for work started by the system
(wake turns, schedules), and they leave every plugin to parse ids. The same need appears in the
team example's group chats and in Keith's multi-person isolation, and in other harnesses as the
`resourceId` of Mastra and the namespace of the LangGraph store.

## Decision

1. **A `Principal` type, serializable and not interpreted by the core.** It has the same shape as
   `ApprovalActor` (`{ id: string; name?: string; [key: string]: JSONValue | undefined }`), and
   `ApprovalActor` becomes an alias of it. There is one type for "a person or system acting", used
   for the asker and for the answerer.
2. **Where it comes from.** `agent.session(id, { principal })` sets the session default, stored in
   `state.core.principal` when the session is first opened. `send(input, { principal })` overrides it
   for one turn. `ctx.principal` in every hook and tool context is the turn's principal, else the
   session's, else `undefined`.
3. **It is durable wherever a turn can move.** Inbox `send` items, `activeTurn`, external waits
   and the `respond()` continuation store the principal, so a turn drained, recovered or continued
   on another instance sees the same one. A wake turn started by a background child's report uses
   the principal of the turn that delegated.
4. **Children inherit it.** `subagent` and `fork` children get the parent turn's principal unless
   the caller passes another one.
5. **A scheduler fire** uses the principal stored with the schedule's `payload`, or the session
   default. The core adds no field to `Schedule`.
6. **The core never trusts or checks it.** Authenticating a person is the app's job (`http`
   `authorize`). The core only carries the value. `ctx.runtime` is unchanged.
7. **Plugins that key on a person use it.** `memory.roots(ctx)` and `budget.scopes(ctx)` can read
   `ctx.principal.id` instead of parsing the session id.

## Consequences

+ Wake, recovery, scheduler and subagent paths stop losing the person. Apps delete id parsing.
+ Shared sessions become expressible: grants and budgets can follow the asker (see ADR-0070).
+ One shared type for asker and answerer.
− New persisted fields in `state.core`, inbox items and `activeTurn`: adapters and the conformance
  suites must round-trip them. Older stored data has no principal, which reads as `undefined`.
− A larger `ctx` surface. `Principal` is not generic yet; a typed variant belongs to the
  typed-runtime roadmap item.
− An app that stores secrets in `attrs` would persist them. The spec says to store identifiers only.

## Alternatives considered

- **Put the person in `runtime`.** Rejected: `runtime` is per process and deliberately not
  persisted; making it durable would persist arbitrary objects, including secrets.
- **Only encode it in the session id.** Rejected: shared sessions and system-started turns have no
  single person in the id.
- **A new `requester` type separate from `ApprovalActor`.** Rejected: two near-identical types for
  the same idea.
