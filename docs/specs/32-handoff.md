# Spec 32 — Handoff (`eharness/handoff`)

Status: **Draft**. Module: `src/handoff/*`. Builds on spec 11 §4.2 (external waits), ADR-0014
(never drop a tool call without a result), P46 W4.

An agent hands a question or decision to a person, the turn parks, and an answer from anywhere (a
web app, a chat reply, another instance) resumes the same assistant message. Products: a team
decision center, live chat handoff to a human agent, automation approval steps.

The module imports core only through `src/index.ts`, has no Node-only code and no dependencies.
Apps supply the store, the notification (a card in a chat or the web) and the routes that answer.

## 1. Request

`HandoffRequest`: `id` (`<sessionId>:<waitId>`), `sessionId`, `toolCallId`, `waitId`,
`kind` (`decision` | `question` | `takeover`), `title`, `body`, `options?` (`{ id, label }[]`),
`audience?` (role names or person ids, app-defined), `urgency?`, `expiresAt?`, `metadata?`,
`status` (`open` | `answered` | `expired` | `cancelled`), `answer?` (`{ optionId?, text?, by, at }`),
`createdAt`. Only `open` moves, once, to one of the other three.

## 2. The store port

All methods are async. Memory adapter only in the library (`memoryHandoffStore()`).

- `create(input)` idempotent by id; returns `{ request, created }`.
- `get(id)`; `list({ status?, sessionId?, audience?, limit?, cursor? })` oldest first with a
  `nextCursor`. `audience` matches requests addressed to any listed name plus unaddressed ones.
- `answer(id, answer, extras?)` and `cancel(id)` are compare-and-set out of `open`. `extras.metadata`
  is shallow-merged into the request's `metadata` in the same transition (winner only), so an app
  stores its outcome atomically with the claim. Result:
  `{ ok: true, request }` or `{ ok: false, reason: 'already-answered' | 'expired' | 'cancelled' |
  'not-found', alreadyAnswered?: true, request? }`.
- `expire(now)` marks open requests with `expiresAt <= now` expired and returns them.

## 3. The plugin

`handoff({ store, notify?, toolName?, defaultExpiryMs?, describe?, now? })` registers one
`externalTool()` (default `ask_person`, risk `write`, idempotent). Its `start` (which runs after the
pending state is committed, idempotent by wait id) creates the request, calls `notify(request, ctx)`
only when it was newly created, and returns `{ correlationId: request.id, payload: { handoffId } }`.
With `defaultExpiryMs` it also sets `timeoutAt` and an `onTimeout` output, so the core wait times out
with the same text. A throwing `notify` is logged and the request stays open.

`startHandoff({ store, notify?, defaultExpiryMs?, now?, sessionId, waitId, toolCallId, ctx, request })`
is what `start` does, exported as a building block: an app's own `externalTool()` (its own input
schema, categories, attribution) calls it from `start` and returns its result. `request.id` may
override the default `<sessionId>:<waitId>`.

## 4. Resolving

`resolveHandoff({ store, sessions, id, answer, output?, resume?, metadata? })`: validates the option
id (unknown or empty answers are `invalid`, nothing changes), compare-and-sets the store (with
`metadata` as the answer's extras), then calls `session.resolveWait(request.waitId, { output },
resume)`. `output(request, answer)` is what the parked tool call receives; the default is
`formatHandoffAnswer`: "`<by> chose <label>: <text>`" (`answered` without an option, `took over` for
`takeover`). `resume` is the third argument of `resolveWait` (`SendOptions` plus `actor`: output spec,
`maxSteps`, `ifBusy`...). Returns `resolved` (with the `ResolveWaitResult`; `continued` carries the
run), `already-answered` (**nothing is delivered**, so a losing answer never races the winner),
`closed`, `not-found` or `invalid`. `sessions` is anything with `session(id)`, normally the agent.

`redeliverHandoff({ store, sessions, id, output?, resume? })` is the explicit crash recovery: when the
request is `answered` and the session's `pendingWaits()` still lists its wait, it delivers the stored
answer (`resolved`); otherwise it returns `already-answered` without a delivery. Run it from a
sweeper, not concurrently with the answer that is being delivered.

`cancelHandoff` cancels and resolves the wait with a cancelled text. `expireHandoffs({ store, sessions,
now? })` expires due requests and resolves each wait with an "expired, no answer" text; run it from a
sweeper. A tool call never stays without a result (ADR-0014).

## 5. Conformance

`handoffStoreConformance(factory)` in `src/testing/handoff.conformance.ts`: idempotent create,
parallel answers have one winner, cancel, expire, list filters and cursor.
