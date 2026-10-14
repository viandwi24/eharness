# P46 — Platform rings: shared modules for four products, toward a stable core

Status: in progress (2026-10-14). Owner: maintainer. Decisions: [ADR-0062](../decisions/0062-platform-rings-and-rule-of-two.md),
[ADR-0063](../decisions/0063-scheduler-module.md).

## Why

eharness is the base of four products: a virtual company and team agent (`examples/team`), a coding
agent (`examples/coder`), a live chat (customer conversations on a web widget and chat apps) and an
automation system (triggers, schedules, durable runs). It is also an open-source library others
adopt. An audit (2026-10-14) found:

- a strong, well-verified core (sessions, loop, compaction, plugins, approvals, multi-instance);
- a product layer that grew out of one app (the team example is larger than the library);
- machinery every one of the four products needs that lives only in the team app: a scheduler,
  chat-platform delivery (rate governor, outbox, mention safety), identity (people, accounts, roles,
  pairing), human handoff, step budgets and readable budget stops, a clock;
- the same permission UX, web search and provider selection rebuilt in two examples;
- typing gaps: both examples cast to `HarnessAgent`, and the team casts `session.inject`;
- Draft modules no example uses (`group`, `guard`, `openapi`, `client/react`).

AI SDK 7 now ships loop-level features (signed tool approvals, telemetry, sandbox sessions, durable
`WorkflowAgent`). eharness keeps its value where AI SDK has nothing: sessions and their storage,
compaction, plugins and context, subagents, the virtual file system, and the multi-person and
multi-channel layer.

## Rings (ADR-0062)

```
Ring 0  eharness              session · loop · compaction · plugin · messages · stream ·
                              permissions · filesystem · subagent · testing      → 1.0, stable
Ring 1  official modules      scheduler · channels · identity · handoff · limits · clock ·
                              connectors · providers · http · client · code · activity → Draft
Ring 2  adapters              SQLite / Postgres stores, platform transports (separate packages, later)
Ring 3  products              team · coder · live chat · automation (own repositories, later)
```

Rule of two: a capability moves into the library when two products need it; until then it stays in
the product.

## Work items

| # | Item | Who | Wave | Status |
|---|---|---|---|---|
| W1 | `eharness/scheduler`: `ScheduleStore` port, memory store, multi-instance scheduler (compare-and-set claims, leases, catch-up, overlap, deterministic fire ids), injected cron `next`; spec 29 | agent | 1 | done |
| W2 | `eharness/identity`: persons, accounts by stable platform id, labels, events, hashed single-use pairing codes, `resolveRole`, `decideByRisk`; spec 30 | agent | 1 | done |
| W3 | `eharness/channels` (first slice): rate governor, outbox with retries, dead letter and circuit breaker, mention tokens and handle neutralising; spec 31 | agent | 1 | done |
| W4 | `eharness/handoff`: ask a person and park the turn (external wait), decision store port, resolve from any instance; spec 32 | agent | 2 | done |
| W5 | `eharness/limits`: `stepBudget` (extend `maxSteps` in chunks up to a cap) and `budgetNotice` (a readable notice when the ledger stops a turn); `eharness/clock`: datetime tool and zone arithmetic; specs 33–34 | agent | 2 | done |
| W6 | Generic flow: `defineHarnessAgent` and sessions keep their kind and message types through plugins, so products need no `as unknown as HarnessAgent` and `inject` is typed | agent | 2 | done |
| W7 | Wiring: package exports, tsdown entries, import rules, exports snapshot, testing exports, API stability table, CLAUDE.md layout, docs index | maintainer | each wave | done |
| W8 | Deprecate `eharness/group`, `eharness/guard`, `eharness/openapi` (JSDoc `@deprecated`, docs); removal at 1.0 unless a product adopts them. `client/react` stays: the live chat widget is a planned consumer | maintainer | 1 | done |
| W9 | Canary releases: changesets snapshot workflow so products install every library commit | maintainer | 3 | done |
| W10 | AI SDK 7 alignment: research the shipped approval signing and telemetry APIs, adopt them where eharness runs a parallel layer, reduce `experimental_*` use | agent | 3 | done |
| W11a | The team app uses `eharness/clock`, `eharness/limits` and the channels mention helpers in place of its own copies (same behaviour) | agent | 3 | done |
| W11b | The team app's routines run on `eharness/scheduler` (SQLite `ScheduleStore` passing the conformance suite) | agent | 3 | done |
| W12 | Full suite, review, changesets, board | maintainer | end | done |

Later (not in P46): the team app moves its people directory, outbox and decision center onto the
`identity`, `channels` and `handoff` ports (the gateway reads roles synchronously today, so this is
its own step), SQLite and Postgres adapter packages, the channels gateway slice after a second
platform, product repositories, live chat and automation products, eval and replay harness, OTel
conventions, 1.0 stability pass.

## Spec and ADR numbers

Specs 29 scheduler, 30 identity, 31 channels, 32 handoff, 33 limits, 34 clock. ADRs 0062 (rings,
rule of two), 0063 (scheduler module, amends 0040).

## Notes from the work

- W3 mentions use the token characters the team app has stored since P41 (U+E010, U+E012,
  U+E011), so existing messages stay valid; the team module re-exports the library.
- W5 fixed an off-by-one of the team step budget (the cap is now exact).
- W6: four of the five casts in the examples were stale; the real gap was `NoticePayload.code`,
  now open to app codes.
- W11b keeps the team's `routines` table (four columns added by migration 0033); the scheduler
  claims with its own version column, so a fire no longer conflicts with an open editor.
- Follow-ups: the scheduler sets `lastFireAt` even when `fire` decided not to fire; `put` with an
  expected version for concurrent edits; flood-storm detection in the outbox.

## Open questions

- Product repositories public or private (decides what stays in `examples/`).
- npm scope for adapter packages (`@eharness/*`).

## W10 findings (AI SDK 7.0.137 alignment)

- **Approval signing is AI SDK's, not parallel.** eharness only forwards `approval.secret` as
  `streamText({ experimental_toolApprovalSecret })`; AI SDK signs requests and verifies replays.
  eharness has no signing code of its own. `toolApproval` is stable. No change needed.
- **Telemetry is already passed through** as the stable `telemetry` option (`agent.config.telemetry`);
  `experimental_telemetry` is a deprecated alias. `registerTelemetry()` (global, stable export of
  `ai`) works with no eharness code. eharness `observe` stays separate (it covers session phases the
  AI SDK cannot see). Recommendation: document `registerTelemetry` in the observability guide.
- **Still experimental, no stable alternative in 7.0.137:** `experimental_refineToolInput`,
  `experimental_toolApprovalSecret`, and the `Experimental_SandboxSession` types (shell, code).
  The two options are now named only in `src/internal/ai-compat.ts`; `src/ai-sdk-experimental.test.ts`
  guards them against renames. Sandbox types are type-only imports in subpaths (which may import core
  only via `src/index.ts`); recommend re-exporting one `SandboxSession` alias from core if they churn.
- Deprecated `experimental_on*` callbacks are unused by eharness. `experimental_events` appears only
  as an `@ai-sdk/mcp` client option mentioned in a comment.
