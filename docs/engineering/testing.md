# Testing

## Runner

`bun test` (Bun's built-in runner, Jest-compatible API: `describe`, `test`, `expect`). Tests live
next to the code as `*.test.ts`. No network in unit tests.

## Model mocking

Use AI SDK's mocks from `ai/test`:

```ts
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
```

`eharness/testing` wraps them in helpers for scripted conversations:

```ts
import { scriptedModel } from 'eharness/testing'

const model = scriptedModel([
  { toolCalls: [{ toolName: 'read_file', input: { path: '/a.md' } }] },   // step 0
  { text: 'Done.' },                                                        // step 1
])
```

`scriptedModel` records every call's prompt so tests can assert on the projected wire. Streaming
calls (eharness steps) and `generateText` calls (the compaction summarizer) take entries from the
same script in call order, so one scripted model can drive a conversation that compacts.

## Test layers

| Layer | What | Where |
|---|---|---|
| Unit | deterministic functions: projection, ids, path validation, smart replace, transcript rendering, frontmatter parser, token estimates | `src/**/*.test.ts` |
| Contract / conformance | adapters satisfy their contract | `src/testing/*.conformance.ts`, run against memory adapters in our suite |
| Integration | full turns with `scriptedModel`: streaming, persistence per step, compaction triggers, abort, errors, hooks order, plugins, skills, fs tools | `src/**/*.int.test.ts` |
| Golden | projection outputs and stream chunk sequences (`__golden__/*.json`) | updated only intentionally (`UPDATE_GOLDEN=1 bun test`) |
| Package | build + publint + attw + Node import smoke | CI (`bun run check:package`, node-compat job) |
| Type tests | inference of `InferHarnessUIMessage`, namespaced data parts, `ctx.stream.data` keys | `src/**/*.test-d.ts` checked by `tsc` |

## Conformance suites (public, in `eharness/testing`)

Runner-agnostic: each suite returns a list of named async cases; adapters for the runner are one
line.

```ts
import { messageAdapterConformance } from 'eharness/testing'
import { describe, test } from 'bun:test'

describe('postgres MessageAdapter', () => {
  for (const c of messageAdapterConformance(() => postgresMessages(db))) test(c.name, c.run)
})
```

Suites: `messageAdapterConformance`, `stateAdapterConformance`, `fileSystemConformance`,
`skillSourceConformance`, `idGeneratorConformance`.

Minimum cases for `messageAdapterConformance`: ordering by id for out-of-order saves; upsert
replaces; `fromId` inclusive; `beforeId` exclusive + limit returns newest; `{ limit }`; empty
session; session isolation; JSON round-trip with unknown keys and data parts; returned arrays are
copies; `lastId` (if implemented).

## Must-have integration scenarios (v0)

1. Two-step turn (tool call → answer): exact stream chunk order (golden), one assistant message
   saved three times (after step 0, after step 1, final with metadata) with the same id, final
   metadata (usage, stop `complete`).
2. Reload: new agent instance + same adapters → `session.messages()` equals stored; next turn
   projection equals what a hot session would send (round-trip test).
3. Abort mid-step: partial assistant saved with `stop: 'aborted'`; stream ends with `abort`.
4. Provider error (mock throws 429): `stop: 'error'`, `eh.notice` saved, `describeError` text.
5. Pre-turn compaction: marker saved, pointer in state, cold load issues exactly one `load({ fromId })`.
6. Mid-turn compaction: `partial` honoured in projection; history intact.
7. Guard: a tool call without result gets a synthesized `Interrupted:` error result; an orphan
   result is removed; hard cap truncation warning.
8. Static vs dynamic: static skill + fs skill source, duplicate handling, `refresh: 'turn'` picks
   up a new SKILL.md at the next turn but not mid-turn.
9. Filesystem tools: read-before-edit, STALE path, CONFLICT via concurrent write, hidden skills root.
10. Plugin services: provider/requirer order errors; `ctx.services.fs` inside tools.
11. Data parts: transient not persisted; persistent reconciled by id; unknown part warning.
12. `inject()` (default `deliver: 'next-turn'`) during a running turn appears in the next turn's
    projection, not the current one.
13. Input normalization: a client message containing tool parts or any `data-*` part (e.g.
    `data-eh.compaction`) is rejected (`EH_INVALID_INPUT` run error); a client `metadata.eharness`
    (including `kind`) is discarded and rebuilt; client ids are replaced and kept as
    `metadata.eharness.clientId`. Golden: user id < assistant id for cold, hot and
    clock-skewed (floor) sessions.
14. `tool-pending`: a tool without `execute` ends the turn with `stop: 'tool-pending'` instead of
    looping to `max-steps`.
15. Failure semantics: session open failure / lock rejection / storage failure produce a valid
    stream (`start` → `error` → `message-metadata` → `finish`) and a resolved `run.result`;
    nothing is persisted (no assistant message, no notice, no state write); only
    `EH_SESSION_BUSY` / `EH_SESSION_CLOSED` throw from `send()`.
16. Tool search across steps (P6): a deferred tool found by `tool_search` in step 0 is callable in
    step 1 and still in step 3; after reload it is still discovered.

Harness interaction and robustness (spec 05, 11; mostly P2 and P7):

17. Approval (policy `user-approval`): turn stops `tool-pending`, `state.core.pending` and
    `metadata.eharness.pending` set; `respond({ approvals: [{ approved: true }] })` continues the
    **same** message id, the tool runs once **before** the next model call; a denial reaches the
    model as `execution-denied` with the reason. Golden chunk order of the continuation. With a
    steer waiting and a step reminder configured, step 0's prompt still ends with the `tool`
    approval message (reminder/steer appear from step 1). With `approval.secret`, the patched part
    keeps its `signature` and the continuation succeeds; a non-deterministic `tool.before` is caught
    by a test helper.
18. `respond()` safety: unknown id, incomplete answers, stale (a newer message exists) and a
    replayed identical request all end with `EH_INVALID_INPUT` and execute nothing; the replay
    finds nothing pending. Two agent instances on one state adapter with `setIf`: a concurrent
    replay is accepted by exactly one. A respond turn killed after consuming pending: the next
    `send` projects the approved-but-unexecuted call as `INTERRUPTED_UNKNOWN`, provider mock
    accepts the wire.
19. `onNewInput`: `'deny'` patches pending parts to `output-denied` / `output-error` and the next
    projection contains the denials before the new user message; `'reject'` → `EH_PENDING_RESPONSE`.
20. Approval combination: policy `approved` + hook `denied` → denied; hook throws → denied; grant
    `always` upgrades `user-approval` only; `remember: 'session'` persists across a reload.
21. Client tool: `respond({ toolOutputs })` continues the message; output limits apply.
22. `handleChatRequest` dispatch with real `useChat` bodies: submit, regenerate, approval answers,
    edit of an older message; tampered client parts are ignored.
23. Regenerate / edit: `eh.rewind` saved, hidden messages excluded from projection, compaction and
    `messages()` (included with `includeHidden`); reload gives the same view; `afterId` before the
    compaction boundary → `'beyond-compaction'`. Id order golden: rewind < user < assistant, so
    the new turn itself is never hidden.
24. Steer: input sent with `ifBusy: 'steer'` during step 0 is stored as `data-eh.input` at the step
    boundary, the model sees it before step 1, a would-be `complete` continues; reload projects
    the identical wire (stored order = model order).
25. Queue: two `ifBusy: 'queue'` sends run in order after the current turn; `abort()` drops them
    (`stop: 'aborted'`, nothing persisted). A steer waiting when the turn stops with
    `tool-pending` is not used and produces `input-dropped`.
26. Wake: `inject(kind, data, { wake: true })` on an idle session starts a no-input turn;
    `deliver: 'next-step'` during a turn is delivered once (kind message has `deliveredIn`, not
    projected twice).
27. `turn.beforeEnd`: `continue` runs one more step with `data-eh.input { source: 'plugin:…' }`;
    `maxContinues` / `maxIdleContinues` bound → `W_CONTINUE_LIMIT`; `extendSteps` lifts `max-steps`;
    progress guard (repeat, error streak, nudge, `'stuck'`); wrap-up step after `max-steps`.
28. `input.submit`: rewrite is re-normalized; `block` → `stop: 'blocked'`, nothing persisted (or
    user message + notice with `persist`); a throwing hook blocks (fail closed).
29. Crash recovery: kill a turn after the tool call was saved (simulated by dropping the session
    without end path); a second agent instance recovers on the next `send`: dangling call answered,
    `stop: 'interrupted'`, `eh.notice EH_TURN_INTERRUPTED`, tool not re-executed; a fresh foreign
    heartbeat → `EH_SESSION_BUSY`.
30. Abort / timeout with a running tool: stored tool part becomes `output-error` `Interrupted:`;
    `turnTimeoutMs` → `stop: 'timeout'`; an AI SDK `chunkMs` timeout → `stop: 'timeout'`.
31. Tool errors: the UI `errorText`, the stored part and the model wire all carry the same
    `String(error)` (not "An error occurred.").
32. Tool output limits: a 200k-char result is truncated head+tail with `W_TOOL_OUTPUT_LIMITED`;
    with `evict` + filesystem the full text is readable via `read_file`.
33. Prompt layout: instructions are two stable system blocks across 3 turns; turn/step reminders
    appear only on the wire (never stored, never in the UI stream); Anthropic mock receives
    `cacheControl` only in cache mode and only for Anthropic model ids; `toolOrder` stable.
34. Overflow recovery: first call fails with a context-length `APICallError` before streaming →
    `W_OVERFLOW_RETRY`, compaction, retry succeeds, the held-back error chunk never reaches the
    client; when the compaction retry and the tighter-guard retry overflow too (three failed
    calls) → `stop: 'error'` `EH_CONTEXT_OVERFLOW`, the error chunk forwarded once.
35. Per-turn overrides: `send({ model, settings, options })` validated by `callOptions`,
    `turn.prepare` can switch model; a model switch drops foreign-provider reasoning in projection.
36. Chunk cloning: `attach()` replays chunks equal to what the first reader saw even when a data
    part was later reconciled by id.

## Coverage

Target ≥ 90% lines for `src/messages`, `src/session`, `src/compaction`, `src/skills`,
`src/filesystem`. Coverage is informative in CI (not a gate) until 0.1.0.
