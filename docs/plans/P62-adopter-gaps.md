# P62 — Adopter gaps: SQLite adapters, ctx everywhere, turn principal, actor grants, turn lifecycle

Status: todo · Owner: Riz · Branch: `main` (no phase branch, like P13–P20)

## Goal

After this phase an app on eharness can run multi-user and multi-replica without rebuilding the
same glue: it installs a SQLite adapter package instead of copying ~2,000 lines of stores, it
varies every policy option per session or per person through `ctx`, every turn knows durably who
asked for it, an "always allow" of one person does not apply to another, and a graceful shutdown or
restart leaves a turn in the same readable state as a crash recovery.

## Why (rule of two, ADR-0062)

Every item below was found twice: in `examples/team` (Ring 3) and in Keith
(`viandwi24/keith`, Ring 3, built on 0.9.0 from npm), and matches what other harnesses expose
(LangGraph checkpointers and `BaseStore` namespaces, Mastra `resourceId` and storage adapters,
OpenAI Agents `Session`). Items that only one product needs were left out (Keith's usernames and
owner transfer, its brain events, the team's persona and scripts).

| # | Gap | Team example | Keith | Kind of app that hits it |
|---|---|---|---|---|
| A | No persistent adapters ship; each app copies examples | `server/src/infra/eh/storage.ts`, `stream-log.ts`, `schedule-store.ts`, `profile-store.ts`, `infra/db/activity-store.ts` | `packages/db/src/eh/*` (9 adapters, ~2,000 lines, copied from the team example) | every production app |
| B | Options that cannot vary per session (`ctx`) | API agents are built apart from the agent factory, with their own namespace (`infra/eh/api-agents.ts`) | compaction model proxy `roleSummarizer` (`providers/role-model.ts`), per-person timezone and catalog planned in P9 | multi-user, multi-tenant, bring-your-own-key |
| C | No durable "who asked" on a turn; `runtime` is per process | only `workspaceId`/`agentId` in the session `runtime` set at open (`infra/eh/agent-factory.ts:754`); group chats (P41) share one session among many people | person derived from the session id `front:<id>` in hooks, wake turns and workers (P9) | group chats, multi-user sessions, schedulers, multi-replica |
| D | Grants keyed by tool only; `permissions` session rules engine-wide | shared chat sessions | a member's approval must not grant the owner's session; `motor/remote.ts` keeps its own grant map | team chat, live chat, any shared session |
| E | Shutdown aborts a turn silently; own stale lease cannot be taken over; no public "active turn" read | graceful stop in `main.ts` | `resume/resume.ts` casts `state.core.activeTurn` and rewrites stop metadata; lock adapter adds `takeOver` | every long-running server |

## Specs

- `docs/specs/05-session-and-storage.md` §1, §2, §4, §7, §8, §9, §12, §13
- `docs/specs/06-compaction.md` §1
- `docs/specs/11-interaction.md` §3.1
- `docs/specs/12-models-and-cost.md` §4.1
- `docs/specs/14-memory-plugin.md` §2
- `docs/specs/18-permissions-plugin.md` §7
- `docs/specs/20-subagent-plugin.md` §2
- `docs/specs/22-web-plugin.md` (fetch policy), `docs/specs/34-clock.md`
- New: `docs/specs/36-sqlite-adapters.md`

## Owns

- `packages/sqlite/**` (new workspace package, published separately)
- `src/agent/**` and `src/internal/**` for C, D and E only
- `src/subagent/types.ts`, `src/subagent/env.ts`; `src/permissions/plugin.ts`, `src/permissions/engine.ts`;
  `src/clock/plugin.ts`; `src/web/fetch.ts`; compaction settings in `src/agent/types/*`
- `src/testing/*.conformance.ts` (new cases only)
- The specs above, ADR-0068 to ADR-0070, `docs/plans/roadmap.md`, `docs/plans/README.md`, changesets

## Scope

- In: A to E below, backward-compatible (every current option value keeps working), Node ≥ 22 and Bun.
- Out:
  - Postgres package. It follows A with the same layout once A is stable.
  - Rate-limit port, OTel spans, approval expiry and quorum, new hooks, session delete/list,
    semantic memory, exported notice and stop-reason constants. These are follow-up candidates,
    listed at the end.

## Workstreams

### A. `@eharness/sqlite` (Ring 2 package, ADR-0068)

- A workspace package `packages/sqlite`, published as `@eharness/sqlite`. It is never a dependency
  of `eharness` (ADR-0008 holds); `eharness` is its peer.
- A small driver interface `SqlDriver`: `exec`, `query`, `run`, `transaction`. It ships drivers for
  `bun:sqlite` and `node:sqlite` (Node ≥ 22.5), each on its own subpath, so the root entry imports
  neither.
- Adapters, one per port:
  - session core: `MessageAdapter`, `StateAdapter` with `setIf`, `SessionLock` (lease, see E3);
  - `InboxAdapter`, `StreamLogAdapter`, `BudgetLedger`;
  - `ActivityStore`, `ScheduleStore`, `OutboxStore`, `HandoffStore`, `PersonStore`;
  - `ProfileStore` and `SealedProfileStore`.
- `createSqliteStorage(driver, { prefix? })` returns the storage bundle that `createAgent` takes
  (`messages`, `state`, `lock`, `inbox`, `streams`), plus each store on its own.
- Schema: versioned migrations in code (`migrate(driver)`), tables prefixed (default `eh_`), and a
  `schema_version` row. Apps that already have tables can keep them, because every adapter also
  takes table names.
- Cross-process notify: polling with a configurable `pollMs`. SQLite has no LISTEN, and the spec
  already allows polling.
- Source: merge `examples/team/server/src/infra/eh/*` and Keith's `packages/db/src/eh/*`, keeping
  the stricter behavior of the two where they differ (Keith's inbox dedupe window and dead letters,
  the team's activity `seq`).

### B. `ctx` for every policy option (spec changes, no ADR)

Each option also accepts `(ctx) => value | Promise<value>`, read once per turn like `memory.roots`:

- `subagent({ agents })`: the catalog function receives `ctx` (today it is `() => Record`). It is
  evaluated per turn of the parent, so the cache that holds it "once per session" goes away.
- `permissions`: **bug fix only, no `ctx` option** (ADR-0070 point 3). The engine is one
  session-agnostic object, so rules added with `scope: 'session'` (the engine-wide `sessionRules`
  `Set`, `engine.ts`) are kept per session id instead: `allow`/`addRule`/`removeRule` take
  `{ session }`, `decide`/`decideAsync` take the id, the plugin passes `ctx.session.id`. Without an
  id the old engine-wide behavior stays, with a one-time warning. `rules(ctx)` and `roots(ctx)` on
  the engine moved to the follow-up candidates: no second consumer yet (rule of two).
- `clock({ timezone })`: `(ctx) => string`.
- `webFetch({ allow, deny })`: `allow(host, ctx)` and `deny` as a function.
- `compaction.model`, `keepLast`, `summarizeAt` and the flush model take `(ctx)`, so a per-person or
  per-tenant model reaches the summarizer without a proxy model.

### C. Turn principal (core, ADR-0069)

- A serializable type `Principal` with the shape of `ApprovalActor`
  (`{ id: string; name?: string; …JSON }`); `ApprovalActor` becomes an alias, so asker and answerer
  share one type. Core never interprets it.
- Who the principal is:
  - `agent.session(id, { principal })` sets the session's default principal, stored in
    `state.core.principal` on first open;
  - `send(input, { principal })` overrides it for one turn.
- `ctx.principal` is set in every hook and tool context. It is resolved in this order: the turn's
  principal, the session's principal, then `undefined`.
- Durable paths: inbox `send` items, `activeTurn`, and external waits store the principal. A turn
  drained or recovered on another instance, a wake turn, a scheduler fire, and a `respond()`
  continuation therefore see the same principal.
- Child sessions (`subagent`, `fork`) inherit the parent turn's principal unless the parent passes
  another one.
- `respond({ approvals: [{ actor }] })` keeps recording who answered; `principal` records who asked.
- Budget `scopes(ctx)` and `memory.roots(ctx)` can key on `ctx.principal.id`. That replaces parsing
  session ids, which is the pattern Keith uses today.

### D. Actor-scoped grants (core and permissions, ADR-0070)

- New option `grants: { by: 'session' | 'principal' }`, default `'session'`, which is today's
  behavior.
  - With `'principal'`, a grant is stored under `<principal id>\u0000<tool key>`, so A's "always
    allow" never answers B's call in a shared session.
  - A call without a principal uses the session key.
- Grant timing (spec 11 §3.1). Today a grant recorded by `respond()` applies only after the first
  step of its continuation, so a second call to the same tool in that step asks again. New option
  `grants: { applyAt: 'continuation' | 'now' }`, default `'continuation'` (today). With `'now'` the
  grant applies at once to every call **except** the call ids that `respond()` answered (their
  AI SDK re-validation stays unaffected, which is the original reason for the delay). The default
  flips at 1.0.
- `permissions` session rules are fixed in B (per session id); `grants.by` does not apply to them.

### E. Turn lifecycle (core, spec changes)

1. `agent.close({ inFlight: 'abort' | 'interrupt' })`, default `'abort'` (today). `'interrupt'`
   ends a running turn exactly as recovery would: `stop: 'interrupted'`, an `eh.notice` with code
   `EH_TURN_INTERRUPTED`, and `activeTurn` cleared. UIs then have one code path for "the server
   stopped" and "the server crashed".
2. ~~`session.activeTurn()`~~ **Dropped, already exists:** `ActiveTurn` is exported and
   `peek().stats().activeTurn` / `session.stats().activeTurn` return `{ turnId, kind, messageId,
   owner, startedAt, heartbeatAt, … }` (spec 05 §2.2; documented and tested in 4a5a0383). `principal`
   joins `ActiveTurn` with workstream C. The audit that proposed it missed `stats()`.
3. `SessionLock.acquire(sessionId, { signal, owner })` receives `recovery.instanceId`.
   - A lease lock may treat a lease held by the same `owner` as stale, matching what §9.2 already
     does for `activeTurn`.
   - `lockConformance` gains that case.
   - Adapters that ignore `owner` keep working.
4. Export the stop reasons and notice codes as constants (`STOP_REASONS`, `NOTICE_CODES`). Keith
   matches notice text and parses warning codes out of strings today.

## Checklist

- [x] ADRs written (Proposed, 2026-11-08): [ADR-0068](../decisions/0068-sqlite-adapter-package.md)
      (SQLite package as Ring 2, driver interface, migrations),
      [ADR-0069](../decisions/0069-turn-principal.md) (turn principal),
      [ADR-0070](../decisions/0070-grants-by-principal.md) (grants by principal, grant timing).
      ADR-0067 is taken by `sleep`; the numbers in the first draft of this plan moved up by one.
- [x] ADR-0068 to ADR-0070 accepted (2026-11-08); ADR-0068 amended before acceptance: the driver
      interface is synchronous
- [x] Spec 36 written as a Draft contract (the package does not exist yet)
- [ ] Specs 05, 11, 12, 14 updated with their code (06, 18, 20, 22, 34 done with B; 36 with A)
- [ ] W1 (A and B ran in parallel; E waits for B because both touch `src/agent`):
  - [x] A: `packages/sqlite` (7d210cfe): drivers, adapters for every port, migrations; 150
        conformance cases pass on `bun:sqlite` and `node:sqlite` (Node 26 only; 22.5–22.12 untested).
        Open: CI and release flow only know the root package (publish needs a follow-up); lock
        `owner` takeover and principal round-trip need conformance cases in `eharness/testing`.
  - [x] B: `ctx` options (2b983ff5 to fa7c4f3f) and the permissions session-rules fix per session
        id (10f18fcc). Subagent catalog functions must stay synchronous. The engine `rules(ctx)` /
        `roots(ctx)` moved to the follow-ups. Not run: the examples' own permission tests (they now
        take the no-id fallback and print one warning).
  - [x] E: `close({ inFlight: 'interrupt' })` (fbc42396, reuses `recoverInterruptedTurn`), lock
        `owner` with the opt-in conformance case `leaseOwnerTakeover` (b4818c1b), `STOP_REASONS` and
        `NOTICE_CODES` (b655853d); `activeTurn()` dropped (4a5a0383). Open: the sqlite suites resolve
        `eharness` from `dist`, so run `bun run build` before `bun test ./packages/sqlite` or the new
        lock case is not exercised there (the case itself passed against the sqlite lock in a throwaway
        source-import test). The interrupt test compares with a hand-built crash state, not a killed
        process.
- [ ] W2: C, the turn principal through send, inbox, activeTurn, waits, wake, scheduler and children
- [ ] W3: D, grants by principal and the grant timing change
- [ ] Conformance: every A adapter passes every existing suite on Bun and on Node; new cases for lock
      `owner`, principal durability across instances, and grants by principal
- [ ] The team example moves to `@eharness/sqlite` (proof of the package, no behavior change)
- [ ] Changesets: `eharness` minor (B, C, D, E), `@eharness/sqlite` initial minor; upgrade notes in
      `docs/guides/upgrading.md`
- [ ] Roadmap and board updated; release as 0.10.0

## Acceptance criteria

- [ ] An app wires durable storage with `createSqliteStorage(bunSqlite(db))` and no copied adapter
      code; the same tests pass under `node:sqlite`.
- [ ] A multi-instance test: a turn sent with principal P on instance 1, drained on instance 2,
      parked, woken and continued on instance 1 sees `ctx.principal.id === P` in every hook, and so
      does its subagent child.
- [ ] In a shared session with `grants: { by: 'principal' }`, A's `remember: 'session'` never
      approves B's call; with the default nothing changes (existing tests untouched).
- [ ] A `permissions` session rule added in session S1 does not apply in S2 (regression test).
- [ ] `close({ inFlight: 'interrupt' })` leaves the same stored message and notice as
      `session.recover()` after a crash.
- [ ] A restarted process with the same `instanceId` acquires its own stale lease at once.
- [ ] Every existing test passes unchanged except where a spec change says otherwise.
- [ ] `bun run lint && bun run typecheck && bun test && bun run build && bun run check:package && bun run check:imports` green
- [ ] Changeset added; specs updated

## Open questions

- Package name: `@eharness/sqlite` or `eharness-sqlite`? Conservative pick: the scoped name,
  reserved on npm before the first publish.
- Should `Principal` be generic (`HarnessAgent<…, P>`) like `runtime`? Conservative pick: a fixed
  serializable shape now; generics with the typed-runtime roadmap item.
- Resolved by ADR-0070: grant timing ships behind `grants: { applyAt }`, default `'continuation'`,
  the default flips at 1.0.

## Follow-up candidates (not in P62)

Each one also met the rule of two in the audit of 2026-11-02. Each needs its own phase.

- `@eharness/postgres` on the A layout.
- `rules(ctx)` and `roots(ctx)` on the permission engine (and per-principal session rules). The
  engine is process-wide and `decide` is synchronous; needs a second consumer first.
- A `RateLimitStore` port for `pairingGuard`, governor, subagent throttle and `budgetNotice`, which
  today are in-memory and multiply by N replicas.
- Span-based observe: a start event, span and parent ids, and trace context through inbox and
  children.
- Approval `expiresAt`, `approval.requested` hook, "who may answer" rules.
- Hooks `message.afterLoad`, `session.recovered`, subagent lifecycle events, and `memory.onRead`.
- Session data API: `MessageAdapter.delete`/`list`, plus `agent.deleteSession` across all stores.
- An optional semantic memory port (`search(namespace, query)`).
- Overridable model-visible texts (i18n).

## Requests to other phases

(empty)
