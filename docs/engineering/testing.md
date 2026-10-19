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

## Which command to run

| Command | Runs | Time (2026-10) |
|---|---|---|
| `bun test` | everything: `src`, `scripts`, `examples/*` (team and coder included). What CI and the release workflow run. | about 6 min |
| `bun run test:fast` | unit tests of `src` only: no `*.int.test.ts`, no `src/shell/**` (real child processes and sandboxes) | about 35 s |
| `bun run test:int` | the 62 `*.int.test.ts` files (full turns with `scriptedModel`, including the session fuzz suite) | about 50 s |
| `bun test src/<module>` | one module while you work on it | seconds |

`test:fast` and `test:int` do not replace `bun test` before a commit that touches `src/session`,
`src/loop` or `src/stream`; CI semantics are unchanged (CI still runs `bun test`). Where the time
goes (junit timing, 2026-10-19): the `src` suite is about 93 s of the roughly 375 s of summed file
time, `examples/team` about 204 s and `examples/coder` about 73 s. The slowest library files are
`src/session/fuzz.int.test.ts` (23 s), `src/shell/plugin.test.ts`, `src/subagent/background-park.test.ts`,
`src/subagent/subagent.test.ts`, `src/session/input-files.int.test.ts` and
`src/session/inbox-delivery.int.test.ts` (3 to 6 s each); nothing else in `src` takes over 4 s.
To measure again: `bun test --reporter=junit --reporter-outfile=junit.xml`, then sort the
`<testsuite file=... time=...>` entries.

Flakiness check: `bun test --rerun-each 5 <files>`. The resume replay, inbox, http and client
integration tests, and every `src` `*.int.test.ts` file at `--rerun-each 3`, passed without a
failure (2026-10-19). Tests must not assume wall-clock timing: wait for an event or use fake timers
and injected clocks, never a fixed `setTimeout` delay as a synchronisation point.

## Test layers

| Layer | What | Where |
|---|---|---|
| Unit | deterministic functions: projection, ids, path validation, smart replace, transcript rendering, frontmatter parser, token estimates | `src/**/*.test.ts` |
| Contract / conformance | adapters satisfy their contract | `src/testing/*.conformance.ts`, run against memory adapters in our suite |
| Integration | full turns with `scriptedModel`: streaming, persistence per step, compaction triggers, abort, errors, hooks order, plugins, skills, fs tools | `src/**/*.int.test.ts` |
| Golden | projection outputs and stream chunk sequences (`__golden__/*.json`) | updated only intentionally (`UPDATE_GOLDEN=1 bun test`) |
| Package | build + publint + attw + Node import smoke | CI (`bun run check:package`, node-compat job) |
| Team example | web tests (standalone), real-process scripts `test:instances` / `test:restart` (SIGKILL, two instances on one SQLite file; ephemeral ports, temp dirs, an overall timeout that also kills the servers) | CI `team` job |
| Type tests | inference of `InferHarnessUIMessage`, namespaced data parts, `ctx.stream.data` keys; the 0.8 generics of `eharness/client` (`createAttentionList<Item, Answer>`, `attention.answer<Answer>`, `createChatSession<UI>`, activity records) and of the `eharness/http` principal `P` | `src/**/*.test-d.ts` checked by `tsc` |

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
`skillSourceConformance`, `idGeneratorConformance`, `inboxAdapterConformance` (0.4.0),
`lockConformance` (a `SessionLock`, see below), `multiInstanceConformance` (a whole storage backend shared by several agent instances, see below), `budgetLedgerConformance` (0.5.0; the factory receives the case's static limits), `profileStoreConformance` (`eharness/providers` stores), `connectionStoreConformance`, `credentialStoreConformance`, `enablementStoreConformance`, `flowStoreConformance` (`eharness/connectors` stores), `activityStoreConformance` (`eharness/activity` stores; the factory returns `{ store, peer? }`, a second handle on the same log), `httpConformance` (`eharness/http` handlers; the factory returns `{ fetch, baseUrl? }`, the agent behind it streams a slow reply). `scriptedProvider` is a provider definition with scripted models.

### Lock conformance

`lockConformance(factory, { concurrency?, maxAcquireMs? })` pins the `SessionLock` contract (spec 05
§8). The factory returns a fresh `SessionLock`, or `{ lock, peer?, expire? }`: `peer()` is a second
handle on the **same** lock space (another connection or process object), `expire(sessionId)`
simulates a crashed holder by letting its lease run out without calling the release function (a
lease table: set `until` in the past). Cases: acquire returns a release function and release frees
the session; a held session rejects a second acquire promptly (it must never block); sessions are
independent; release is idempotent and a stale release never frees a newer holder; exactly one of N
parallel acquires wins; with `peer`, a lock held through one handle is held for the other and a
stale release of one handle does not free the other's lock; with `expire`, a crashed holder is
taken over and its late release is a no-op. Adapter-specific options (the team example's
`takeOver`) get their own tests next to the adapter.

```ts
import { lockConformance } from 'eharness/testing'

for (const c of lockConformance(() => ({
  lock: myLock(db),
  peer: () => myLock(openConnection()),
  expire: (id) => db.run('UPDATE locks SET until = 0 WHERE session_id = ?', id),
}))) test(c.name, c.run)
```

It runs against the in-memory lock of `src/session/memory-storage.test.ts` and the team example's
SQLite lock (`examples/team/server/test/eh-conformance.test.ts`, with a second connection as the
peer). The Postgres advisory lock is tied to a connection and has no lease: omit `expire`.

### Multi-instance conformance

`multiInstanceConformance({ makeStorage, connect?, cleanup?, latencyMs? })` runs real agents (a
scripted model, no network) on **one** storage shared by several instances. `makeStorage` returns a
fresh `{ messages, state, inbox?, lock? }` per case; `connect(shared, index)` may return the view of
instance `index` (a new database connection); `cleanup` drops the schema. Cases that need an inbox
or a lock are skipped when the storage has none. The memory adapters run it in
`src/session/memory-storage.test.ts` and the team example's SQLite adapters (one connection per instance, one database file) in `examples/team/server/test/eh-conformance.test.ts`; an application adapter (Postgres, MySQL, Redis) runs it
exactly like the adapter suites:

```ts
import { multiInstanceConformance } from 'eharness/testing'

describe('postgres storage, several instances', () => {
  const suite = multiInstanceConformance({
    makeStorage: async () => ({
      messages: postgresMessages(pool),
      state: postgresState(pool),
      inbox: postgresInbox(pool),
      lock: postgresLock(pool),
    }),
    latencyMs: 5,
  })
  for (const c of suite) test(c.name, c.run, 30_000)
})
```

Cases: B reads the turn A ran; an approval A asked is answered by B and the tool runs once (a
second answer is rejected); two partial answers from two instances; a steer and a queued input
enqueued by B reach the running turn of A and run once; a wake held behind pending approvals runs
once after B answers; a `send(…, { ifBusy: 'wait' })` held in B starts after A answers; B recovers
the turn of a crashed A without re-executing the tool; concurrent sends from two instances neither
overlap nor duplicate. Every case ends with `assertStoredSessionInvariants` (also exported, spec 05
§15) on the stored session.

### Fuzz test

`src/session/fuzz.int.test.ts` is a deterministic property test (seeded PRNG, no dependencies):
per seed two instances share in-memory messages, state, inbox and lock; a random script of 10 to 31
operations (see spec 05 §15) runs against a scripted model whose steps are random (text, approval
tool, slow tool, client tool, provider error). After every operation the invariants must hold, no
turn operation may throw anything but `EH_SESSION_BUSY` / `EH_SESSION_CLOSED`, `run.result` never
rejects, at most one turn runs at a time, and a runaway storage loop is reported. At the end every
leftover is driven to completion (answer pending, recover) and the quiescent invariants are
checked. A failure prints the seed, the stored messages and the op log; reproduce with
`FUZZ_ONLY=<seed> bun test src/session/fuzz.int.test.ts`. `FUZZ_SEEDS` (default 250, about 25 s)
and `FUZZ_START` widen the search; run a few thousand seeds before a release that touches the
session runtime. `FUZZ_TRACE=1` prints `seed <n>` before each seed runs, so a hang or a crash that
kills the process still names the seed that caused it (`FUZZ_ONLY` additionally prints the op log
of that seed). The `Fuzz` workflow (`.github/workflows/fuzz.yml`) runs `FUZZ_SEEDS=5000` every
Monday (and on demand, with `seeds` / `start` inputs); a red run lists the failing seeds.

Minimum cases for `budgetLedgerConformance`: unknown scopes have no limit; reserve up to the limit
and refuse beyond it (refused scope, limit, spent + reserved); a used-up scope refuses a zero
reservation; all-or-nothing over several scopes; 100 concurrent reservations never exceed a
limit; commit replaces a reservation (lower and higher); idempotent commit / release, unknown ids
ignored; reserve idempotent per open key; record once per key (also concurrent); expiry, and a
late commit of an expired reservation still charges; `check` sums.

Minimum cases for `messageAdapterConformance`: ordering by id for out-of-order saves; upsert
replaces (dropped keys stay dropped, never a merge); `fromId` inclusive and between stored ids;
`beforeId` exclusive + limit returns newest; `beforeId` without limit; `{ limit }`; empty
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

## Test preload: invariant violations fail the test

`bunfig.toml` registers `scripts/test-preload.ts` for every `bun test` run. It does two things:

- `debug.invariants` is **explicit only** in the library (it is never inferred from `NODE_ENV`), so
  the preload switches it on for every agent a test defines, unless the test sets `debug.invariants`
  itself.
- A `W_INVARIANT_VIOLATION` raised by a session's own end-of-turn check fails the test that caused
  it (the core only warns, because it must never break a running session; without the preload a
  violation would scroll by in a green run). Direct calls to `checkSessionInvariants` from invariant
  tests are not recorded.

A test that provokes a violation on purpose opts out for that test with
`allowInvariantViolation(/I5/)` (`src/session/test-kit.ts`), which takes a pattern for the expected
problem text. Anything else that matches no pattern still fails. Application test suites do the same
in their own setup: `debug: { invariants: true }` and an `onWarning` that throws on that code.

## Static checks that run next to the tests

| Command | What it enforces |
|---|---|
| `bun run lint` | `biome check` and `scripts/check-throws.ts`: no unmarked `throw new Error(...)` in non-test `src/` (public paths throw `HarnessError`; a deliberate exception carries `// plain-error: <why>` on the line or the line above, or `// plain-error-file: <why>` for a whole file) |
| `bun run check:imports` | `scripts/check-imports.ts` (subpath modules reach core only through `src/index.ts`, no `Bun.*`, no `node:` outside the Node-only modules) and `scripts/check-cycles.ts` (no runtime import cycle between core folders) |
| `bun run check:exports` | `scripts/exports-snapshot.ts` compares the real exports of every entry point with `scripts/exports.snapshot.json`; `bun test` runs the same comparison, and `check:package` runs it against `dist/` |

### Exports snapshot workflow

The snapshot is the reviewed list of every public runtime export, derived from
`package.json#exports`. A change to a barrel (`src/**/index.ts`) fails the check until you regenerate
and review the diff:

```bash
bun scripts/exports-snapshot.ts --write   # rewrite scripts/exports.snapshot.json
git diff scripts/exports.snapshot.json    # every added or removed name is a public API change
```

An added name needs a spec/guide mention and a changeset; a removed name is a breaking change
(`docs/engineering/api-stability.md`). Types are not in the snapshot (the type surface is covered by
`tsc` and the `*.test-d.ts` files).

## Shared test helpers

`src/testing/test-utils.ts` (internal: not exported from `eharness/testing`, not bundled) holds
`sleep`, `until(what, condition, ms)` and the seeded `prng(seed)`. Waiting for an effect is
`await until('what', () => ...)`, never a fixed `sleep` that assumes an order; a random delay comes
from `prng(seed)` with a constant seed so a failure reproduces. No `Math.random()` in tests.

## CI-only guards and environment

- `examples/examples.test.ts` fails (instead of skipping the Postgres block) when `CI` is set and
  `DATABASE_URL` is empty.
- Tests never touch the network: the team MCP legacy-SSE case points at `127.0.0.1:9` (refused at
  once), not a real host.
- `examples/team/web` tests are plain bun tests; they run in the root `bun test` and again
  standalone in the CI `team` job.
- The process scripts blank every `TEAM_*` variable and pass `--no-env-file` to the server, so a
  developer's `examples/team/.env` (a `TEAM_TOKEN`) cannot change what they test.

## Why the suite does not run under Node

CI runs the whole suite on Bun only. The tests are `bun:test` files (`describe/test/expect`
imported from `bun:test`, `mock`, `Bun.serve`, `bun:sqlite` in the examples), so they cannot run
under `node --test` or vitest without rewriting every file. Runtime neutrality of `src/` is
instead enforced by `bun run check:imports` (no `Bun.*`, no `node:` outside the Node-only modules)
and by the `node-compat` job, which installs the packed tarball in a clean project on Node 22 and
24 and imports every entry point. A Node run of a conformance subset would need a second runner
adapter for the cases (they are runner-agnostic `{ name, run }` lists, so it is possible); it is
not worth a second harness until a Node-specific bug escapes.

## Coverage

Target ≥ 90% lines for `src/messages`, `src/session`, `src/compaction`, `src/skills`,
`src/filesystem`. Coverage is informative in CI (not a gate) until 0.1.0.
