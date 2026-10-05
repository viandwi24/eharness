# P13 — Hardening (0.4.0 bug fixes)

Status: done · Owner: agent · Branch: `main` (direct commits; P13–P20 ship together as **0.4.0**)

## Goal

Every verified finding of the 0.3.1 audit (core runtime, feature modules, security, DX) is fixed
with a regression test that failed before the fix, so the feature phases P14–P20 build on a
runtime whose concurrency, accounting and error-exposure behaviour is correct. After this phase:
cold sessions load exactly once, the HTTP stream of a turn ends only after the turn is finalized,
summarizer usage counts against budgets, `grep` cannot freeze the process, client file URLs are
policed, and thrown tool/provider errors no longer leak secrets to clients by default.

## Specs / docs to read

- `docs/specs/05-session-and-storage.md` §1 (session cache), §2 (`SendOptions`, failure
  semantics), §3 (lifecycle, steps 1–17, commit point), §3.1 (pending input vs stops), §5–§7
  (load, hot cache, state), §9 (recovery)
- `docs/specs/11-interaction.md` §6.1 (steer at a stopped turn), §6.3 (`next-step` delivery),
  §7 (`handleChatRequest`), §3.3 (`actor`)
- `docs/specs/06-compaction.md` §5.3 (summarizer), §6 (guard truncation)
- `docs/specs/09-tools-and-mcp.md` §4 (output limits, head + tail helper)
- `docs/specs/08-filesystem-plugin.md` §3 (`read_file`, `grep` formats, fast path)
- `docs/specs/13-todos-plugin.md` §3 (where the list lives)
- `docs/specs/12-models-and-cost.md` §3–§4 (`addUsage`, budgets)
- `docs/specs/10-errors-and-stop-reasons.md` §1 (`EH_CONFIG_INVALID`), §2 (warnings), §3
  (`describeError`)
- `docs/specs/03-messages.md` §8 (ids), §6 (projection)
- `docs/specs/07-skills.md` §8 (frontmatter subset)
- ADR-0011 (stored order = model order), ADR-0014 (interrupted calls)
- `docs/guides/long-running-turns.md:30`, `docs/guides/subagents.md:31`, `README.md` route

**AI SDK verified for this release (2026-10-05):**

- Latest `ai` on npm is **7.0.127** (`https://registry.npmjs.org/ai/latest`), installed 7.0.123;
  latest `@ai-sdk/mcp` is **2.0.66** (installed 2.0.63).
- Changelog 7.0.124–7.0.127 (`https://github.com/vercel/ai/blob/main/packages/ai/CHANGELOG.md`):
  speech/transcription telemetry (124), `convertDataPart` in agent UI stream helpers (125), tool
  approvals cleared when `addToolOutput` executes (126), tool search `search()` ranking callback,
  `maxResults`, cancel merged UI message streams on disconnect, cross-realm tool approval inputs
  (127). No change to `streamText` `output`, `toolApproval`, `toolOrder` or the UI message chunk
  shapes we copy. Item 26 re-checks this against the installed d.ts after the bump.

## Owns

`src/session/**`, `src/agent/**`, `src/loop/**`, `src/stream/**`, `src/messages/ids.ts`,
`src/errors.ts`, `src/compaction/{guard,truncate,summarize,compact}.ts`, `src/registry/wrap.ts`,
`src/internal/provider-errors.ts`, `src/todos/**`, `src/filesystem/tools.ts`,
`src/skills/frontmatter.ts`, `src/testing/message-adapter.conformance.ts`, the matching specs,
guides and README snippets, `package.json` (devDependency bump).

## Scope

- In: findings 1–26 below.
- Out (recorded in `roadmap.md`): `persistEachStep` write amplification (delta / batch
  persistence, `appendParts`), quadratic per-step projection cost (per-message projection cache),
  turn-level tracing / OTel spans, typed `runtime` / `callOptions`, plugin tools in
  `InferHarnessUIMessage`, subagents plugin, `asAgent()` / `HarnessAgent` adapters,
  `TurnBufferAdapter`, `maxSummaryTokens` scaling with the window, budget pre-flight estimate,
  session-cached instruction runtime leak warning.

## Checklist

Rule for every item: **write the regression test first and see it fail**, then fix. Tests live
next to the code (`*.test.ts` / `*.int.test.ts`); cross-cutting session races go into
`src/session/hooks.int.test.ts`, `runtime.int.test.ts` or a new `src/session/races.int.test.ts`.
Commit per item or per small group (`fix(session): …`).

### Core runtime

- [x] **1. [high] Single-flight context load** — `src/session/session.ts:430-463`
  (`ensureContext()`). Test: on a cold session, call `stats()` and `inject()` while `send()` is in
  turn preparation (scripted model + a slow state adapter); assert the user message is still in
  the next step's model context and plugin state set in `session.start` survives. Fix: memoize the
  in-flight load promise; never call `rt.state.load()` while a turn or another load holds the
  state; a stale `rt.view` must never overwrite the hot cache (compare a load generation counter).
- [x] **2. [med-high] `inject(next-step)` during turn preparation** — `session.ts:800-808`.
  Test: inject `next-step` between `send()` and the first step; assert it is delivered exactly
  once in step 0 and that the stored order after a cold reload projects identically to the wire
  the model saw (ADR-0011 round trip). Fix: route injections that arrive before the turn inbox
  is open into the inbox (delivered at the first boundary) instead of both saving them as
  next-turn context and delivering them.
- [x] **3. [medium] Stream ends before the turn finalizes** — `src/session/turn.ts:1393-1446`.
  Test: `await` the HTTP stream to its end, then immediately `send()` → today
  `EH_SESSION_BUSY`; after the fix it succeeds. Fix: write `finish` only after the end sequence
  (final save, `activeTurn` cleared, state persisted, `turn.end` hooks, lock released, running
  flag cleared) — or, if AI SDK's `onEnd` ordering makes that impossible, hold the stream close
  until the end sequence resolves. Update spec 05 §3 steps 16–17 (normative order) accordingly.
  Add:
  - `SendOptions.ifBusy: 'wait'` for `send()` **and** `respond()` (waits for the running turn and
    the queue ahead of it, then runs; honours `abortSignal`; never applies `onNewInput` to
    approvals created by the turn it waited for — it then behaves as a new `send()`),
  - `session.idle(): Promise<void>` (resolves when no turn runs and nothing is queued),
  - `handleChatRequest` never throws `EH_SESSION_BUSY`: it returns a failed run
    (`stop: 'error'`, `error.code: 'EH_SESSION_BUSY'`) whose `toResponse()` answers **409** with
    a JSON body `{ error: { code, message } }` (type stays `HarnessRun`),
  - README route and spec 11 §7 example show the busy handling.
- [x] **4. [medium] Steer at max-steps** — `src/loop/steps.ts:895-900` (+ `:477`). Test: a steer
  arrives while the last budgeted step runs; assert the wrap-up step does not consume it and it
  becomes a queued `send` turn (`turn-start { queued: true }`), as spec 05 §3.1 / 11 §6.1 require.
  Fix: the wrap-up step takes no input; waiting steers follow the "any other stop" rule.
- [x] **5. [medium] `messages()` paging** — `session.ts:906-925`. Tests: (a) after an `edit()`
  that hides the newest messages, `messages({ limit: 2 })` returns two visible messages, not an
  empty page; (b) a cold instance (fresh agent, same storage) excludes hidden messages. Fix: load
  state for reads (no recovery, spec 05 §9), page until `limit` visible messages or history is
  exhausted.
- [x] **6. [medium] Second live handle while closing** — `src/agent/sessions.ts:54-55` +
  `turn.ts:547`. Test: `closeSession(id)` (or idle eviction) then `agent.session(id).send()`
  before close finished; assert no `EH_TURN_INTERRUPTED` notice and only one writer. Fix: the
  registry keeps the closing entry; `agent.session(id)` awaits the close internally (the returned
  handle opens after it) instead of creating a parallel live handle.
- [x] **7. [low-med] Checkpoint restore discards foreign state changes** — `turn.ts:540,:470`.
  Test: a background `ctx.state.set` and a `clearGrants()` during preparation of a turn that then
  fails before commit; assert both changes survive. Fix: restore only the keys the turn itself
  changed (diff against the checkpoint), not the whole snapshot.
- [x] **8. [low] Id floor drift** — `src/messages/ids.ts:66`. Test: 1 000 ids in the same
  millisecond keep their embedded timestamp within 1 ms of the clock (monotonic via the random /
  counter bits). Fix: bump the floor only when the generated id is not greater than it.
- [x] **9. [low] Unbounded warning dedupe set** — `src/errors.ts:189-191`. Test: 10 000 turns
  with per-turn keys keep the set bounded. Fix: bounded LRU (e.g. 1 000 keys) or per-turn keys
  cleared at turn end.

### Feature modules

- [x] **10. [high] Todos lost after restart + compaction** — `src/todos/plugin.ts:177,238-247`.
  Test: write todos, new agent instance on the same storage, force compaction; the carried list
  equals the last list. Fix: compute the list for `compaction.prompt` / `compaction.after` from
  the view (messages) and the carried state, never from a closure that is empty on a fresh
  session.
- [x] **11. [medium] Denied `todo_write` adopted** — `todos/plugin.ts:133-139`. Test: deny the
  call via `tool.approve`; the current list is unchanged. Fix: `execution-denied` counts as a
  failed write (spec 13 §3 "result is not an error").
- [x] **12. [medium] Long single lines unreachable** — `src/filesystem/tools.ts:95-99,107`.
  Tests: a 200 000-char single-line file can be read completely in pages; `evict` of a
  single-line JSON output is fully readable; `grep` hit text beyond 300 chars is reachable. Fix:
  add `read_file` `{ charOffset? }` (character offset inside the first line of the window, with
  the hint `(Line <n> continues; use offset=<n> charOffset=<c>.)`) — a model-visible schema
  change (minor-level in 0.x, golden schema updated); `grep` keeps 300 chars but appends the
  column of the match so `read_file` can reach it. Update spec 08 §3.
- [x] **13. [medium] Guard cannot shrink JSON-escape-heavy outputs** — `src/compaction/guard.ts:88-92`
  vs `:176`. Test: a limited output whose preview is mostly `"`/`\` escapes; the guard fits the
  request instead of `EH_CONTEXT_OVERFLOW`. Fix: measure the serialized (escaped) size in the
  halving loop, the same way spec 09 §4 sizes the preview.
- [x] **14. [medium] Weak message adapter conformance** — `src/testing/message-adapter.conformance.ts:68-98`.
  New cases: an upsert that **drops** keys (replacement, not merge); `fromId` that lies between
  stored ids (no exact match); `beforeId` without `limit`. Verify the suite now fails a merging
  adapter and an index-based `fromId` (test fixtures for both). Spec 05 §4 requirements list
  updated. Note in the changeset: third-party adapters may now fail the suite (they were wrong).
- [x] **15. [low] Numeric-looking skill names/descriptions rewritten** — `src/skills/frontmatter.ts:58-60,455,459`.
  Test: `name: 007`, `description: 1.0` round-trip as strings. Fix: `name` / `description` are
  always read as raw strings.
- [x] **16. [low] `truncateMiddle` splits surrogate pairs** — `src/compaction/truncate.ts:23`.
  Test: emoji at both cut points. Fix: move cut points off a high/low surrogate boundary.
- [x] **17. Verify and fix if confirmed** (write the test first; if it passes, note "not a bug"
  here):
  - `src/registry/wrap.ts:312` — an unknown status string returned by a JS `tool.approve` hook or
    policy is ignored; it must fail closed (`denied`) like a throw.
  - Summarizer `finishReason: 'length'` is accepted silently; treat a cut summary as a failure
    (`W_COMPACTION_FAILED`, details `{ reason: 'length' }`) or retry once with a smaller chunk —
    pick the conservative option (failure) and document it in spec 06 §5.5.
  - Spec 08 §3 vs `tools.ts:343-353` (grep fast-path condition): align code and spec.
  - Results: (a) confirmed and fixed (unknown status → `denied`, test in `approval.int.test.ts`);
    (b) confirmed and fixed (`finishReason: 'length'` → failure, `details.reason: 'length'`, no
    retry); (c) **not a bug in code**: the existing "grep fast path" tests pass — the code always
    tries the adapter first and falls back when hidden hits use up the budget; spec 08 §3 was
    stale and now describes the code.

### Security

- [x] **18. [medium] ReDoS in `grep`** — `src/filesystem/tools.ts:320`. Test: `(a+)+$` against a
  long line returns within 100 ms. Fix: reject patterns with nested quantifiers and
  backreferences (`ERROR: invalid pattern: <reason>`), cap pattern length (e.g. 512) and scanned
  line length (e.g. 10 000 chars per line), fall back to a literal search when the pattern has no
  regex metacharacters. Document in spec 08 §1/§3 that adapters with `grep` push-down should
  apply the same limits (or use a linear-time engine such as RE2 in their backend).
- [x] **19. [medium] Summarizer usage never charged** — `src/compaction/summarize.ts:83`. Test: a
  turn with `budget.maxTurnUsd` and a priced summarizer model; compaction cost appears in
  `TurnResult.usage.costUsd` and stops the turn with `'cost-cap'` when it exceeds the budget
  (the repro was 12× over budget). Fix: return each chunk's usage; charge it through the turn
  (`addUsage(usage, { model, source: 'compaction' })`) for automatic / overflow compaction, and to
  `state.core.usage` for manual `compact()`; check budgets **before** summarizing (a used-up
  budget skips compaction — the guard handles size — with `W_BUDGET`). Spec 06 §5.3 + spec 12 §3.
  **P15 depends on this** (flush usage uses the same path).
- [x] **20. [low] Client file URLs** — `src/session/input.ts:43`. Tests: a `file` part with
  `javascript:` / `http:` / `ftp:` URL → `EH_INVALID_INPUT`; a data URL over the cap →
  `EH_INVALID_INPUT`; a historical file whose download fails (`DownloadError`) does not break
  later turns. Fix: agent option `inputFiles?: { protocols?: string[] /* ['data:', 'https:'] */;
  maxBytes?: number /* data URLs, default 20 MB */ }` checked at input normalization (spec 05 §3
  step 7); projection degrades a historical (not current-turn) file part to the text
  `FILE_UNAVAILABLE` (`[file unavailable: <mediaType> <filename>]`, new constant, spec 10 §5) when
  the step fails with a download error, then retries the step once.
- [x] **21. [low] Thrown tool errors reach the client verbatim** — `src/loop/steps.ts:687`. Test:
  a tool throwing `new Error('postgres://user:pw@host')` with `toolErrorText` set shows the
  mapped text in UI, storage **and** the model wire (they must stay identical, spec 04 §2). Fix:
  agent option `toolErrorText?: (error: unknown, e: { toolName: string; toolCallId: string }) =>
  string`, default = current behaviour (`String(error)`); applied in the execute wrapper so
  `HarnessToolError` carries the mapped text. Document the secret-leak risk in
  `tools-and-mcp.md`.
- [x] **22. [low] Provider error messages passed to clients** — `src/stream/describe-error.ts:32-39`
  + `src/internal/provider-errors.ts:53`. Tests: a plain `Error` with `status: 500` and a URL with
  `?key=…` in its message is described generically; an `APICallError` keeps its message but URLs,
  query strings and key-like tokens (`sk-…`, `Bearer …`, 32+ char hex/base64 runs) are redacted
  and the text is capped (e.g. 300 chars). Fix: trust only `APICallError` / `StreamProviderError`
  (via `isInstance`), redact, cap. Spec 10 §3.

### DX quick wins

- [x] **23. Config validation** — `loop.maxSteps: 0` / negative / non-integer,
  `compaction.summarizeAt` outside `(0, 1)`, `keepLast < 0`, `guard.maxContextRatio` outside
  `(0, 1]`, `progress.*` non-positive, `sessionIdleMs < 0`, `budget.*` non-positive →
  `EH_CONFIG_INVALID` at `defineHarnessAgent`. Duplicate tools: detect at boot when both are
  static (`EH_DUPLICATE_TOOL`); fix docs that claim "at boot" for the session-open cases (spec 01
  §7, `reference.md`).
- [x] **24. `handleChatRequest(session, body, { actor })`** — the options gain `actor?:
  ApprovalActor`, passed to every approval answer of the `respond()` path so
  `approval.decided` receives it (spec 11 §3.3, §7).
- [x] **25. Docs nits** — `docs/guides/long-running-turns.md:30` (`turnTimeoutMs` comment),
  `docs/guides/subagents.md:31` (the example throws inside a tool; return an error string, rule 6),
  README route busy handling (item 3).
- [x] **26. Bump devDependencies** `ai` → `^7.0.127`, `@ai-sdk/mcp` → `^2.0.66` (`bun add -d`),
  regenerate the lockfile, diff the installed `ai` d.ts exports used by `src/` (`Output`,
  `toolApproval`, `toolOrder`, `createUIMessageStream`, `toUIMessageStream` `onError`); peer floor
  stays `ai@^7.0.123` / `@ai-sdk/mcp@^2.0.63` unless a fix needs a newer export (then raise it and
  say so in the changeset). Run `bun run build && bun run check:package` after the bump.

### Closing

- [x] Specs updated in the same commits (05, 06, 08, 09, 10, 11, 12, 13); spec status lines say
  "updated for 0.4.0".
- [x] `docs/guides/reference.md`: new options (`ifBusy: 'wait'`, `idle()`, `inputFiles`,
  `toolErrorText`, `read_file.charOffset`, `handleChatRequest` `actor`, 409).
- [x] Changeset (below); board updated.

## Acceptance criteria

- [x] Every item has a test that failed on 0.3.1 and passes now (item 17 sub-items may close as
      "not a bug" with the test kept).
- [x] A cold session under concurrent `stats()`/`inject()`/`send()` never loses a user message
      or plugin state (item 1 test runs 100 iterations with randomized delays).
- [x] `await run.result` is no longer needed before the next `send()`: the stream end implies
      the session is free (item 3).
- [x] Compaction usage is visible in `TurnResult.usage` / `costUsd` and bounded by budgets.
- [x] `grep` with a catastrophic pattern returns in < 100 ms on Bun and Node.
- [x] `bun run lint && bun run typecheck && bun test && bun run build && bun run check:package && bun run check:imports` green.
- [x] Changeset added; specs updated where behaviour changed.

## Changeset

`patch`, one changeset per commit group or one combined `.changeset/hardening-0-4.md`:

- Fixes 1–22 described for users (what was wrong, what changes).
- New options (additive): `ifBusy: 'wait'`, `session.idle()`, `inputFiles`, `toolErrorText`,
  `read_file` `charOffset`, `handleChatRequest` `actor`.
- Behaviour changes to call out: `handleChatRequest` no longer throws `EH_SESSION_BUSY` (409 run);
  the stream `finish` now arrives after the turn is persisted; client file URLs outside
  `data:`/`https:` are rejected; summarizer usage now counts toward usage, cost and budgets;
  config values that were silently accepted (`maxSteps: 0`, …) now throw `EH_CONFIG_INVALID`;
  `messageAdapterConformance` is stricter; `grep` rejects nested quantifiers/backreferences;
  `read_file` input schema gained `charOffset` (model-visible).
- Type-level: `SendOptions.ifBusy` gains `'wait'` (exhaustive switches over it must add a case);
  `HarnessSession` gains `idle()` (custom implementations/mocks of the interface must add it).
- devDependencies `ai@7.0.127`, `@ai-sdk/mcp@2.0.66` (peer floors unchanged unless stated).

## Open questions

- Item 3 — if `createUIMessageStream` cannot delay `finish` past `onEnd`, the fallback is to run
  the end sequence inside `execute` before returning and keep `onEnd` for the final accumulated
  message only. Decision: try the reordering first; document whichever is shipped in spec 05 §3.
- Item 12 — `charOffset` vs splitting long lines into virtual lines: decision `charOffset`
  (keeps line numbers equal to the file's lines, which `edit_file` users rely on).
- Item 20 — `inputFiles.protocols` default `['data:', 'https:']`; apps that store `http:` URLs
  (internal object stores) must opt in. Conservative: yes.
- Item 22 — redaction patterns are not public API (only the behaviour "secrets are redacted").

Decisions taken while implementing (conservative options):

- Item 1 — single flight: one in-flight load shared by every caller; messages cached while it runs
  are merged into the loaded view. The state is read at most once per load.
- Item 2 — injections before step 0 already went to the inbox; the bug was that the turn's wire
  also projected the kind message. The turn now excludes inboxed kind messages from its build.
- Item 3 — implemented by holding back only the terminal `finish` / `abort` chunk of the turn
  buffer until the end sequence (AI SDK's own stream order is unchanged; `onEnd` still runs
  first). `ifBusy: 'wait'` semantics: joins the FIFO; kept by `session.abort()` (only `close()`
  and its own `abortSignal` drop it); a waiting `respond()` may start while the queue is held by
  pending approvals; a waiting `send()` is held only by pending approvals that did not exist when
  it was called ("never applies `onNewInput` to approvals created by the turn it waited for"),
  approvals already pending at call time are handled like a new `send()`. `idle()` stays pending
  while a queue is held by pending approvals (it resolves after `respond()` or `abort()`).
- Item 7 — "the turn's own changes" = `ctx.state` keys set in the hook owner's namespace while that
  owner's preparation hook (`input.submit`, `turn.prepare`, dynamic tool sources / instructions)
  runs. Context objects keep their identity (MCP keys connections by `ctx`), so no per-turn ctx
  wrapper; a background set in the *same* namespace during that owner's hook is attributed to
  the turn (documented limit).
- Item 19 — a manual `compact()` honours only the session budget; usage of a failed summarizer
  call is charged too.
- Item 20 — a historical file is retried once per failing URL (each retry degrades one URL, so the
  loop ends); storage is not changed.
- Item 21 — a mapper that throws or returns a non-string yields `Error: the tool failed.`;
  invalid / unknown tool call errors are not mapped (they carry only the model's own input).
- Item 26 — the bump moved the transient `data-eh.status { state: 'tool' }` chunk before the first
  `start-step` of a step (AI SDK 7.0.124–127 internals); deterministic, golden
  `two-step-turn.chunks.json` updated and spec 04 §2 notes it.
- Changesets: `hardening-0-4.md` (`patch`: fixes and purely additive options) and
  `hardening-0-4-model-visible.md` (`minor`: every behaviour, type-level and model-visible change).
- Review round 1 (orchestrator decisions): a failed commit-point state write undoes the core
  fields commit() changed, a CAS conflict reloads the state (no phantom `activeTurn`, no
  overwrite of another instance); `grep` uses a conservative safe subset (≤ 1 unbounded
  quantifier, no quantified groups with quantifiers or alternations, no backreferences /
  lookarounds) and scans 2 000 characters per line (worst accepted case a few ms per line under
  bun); `agent.close()` awaits replaced closing handles; waiting sends keep FIFO order (only a
  waiting `respond()` may pass a held queue); `messages()` paging filters by `beforeId` itself.
- Review round 2 (definitive grep rule): at most one variable-width quantifier in total (`*`, `+`,
  `?`, lazy, `{n,}`, `{n,m}` m > n), no quantified group of any kind (even `{n}`), no
  backreferences / lookarounds; fixed `{n}` on a single atom is fine. A CAS conflict discards the
  losing instance's unwritten state (spec 05).

## Requests to other phases

- P15 relies on item 19 (summarizer usage path, `source: 'compaction'`) for flush accounting.
- P16 and P19 rely on items 1, 3, 6 (single live handle, single-flight load, `idle()`).
- P20 documents `toolErrorText`, `inputFiles`, 409 handling and the stricter conformance suite in
  `production-patterns.md` and the adapter guide.

## Dependencies

None (first phase of 0.4.0). Hard dependents: P15 (item 19) and P19 (items 1, 3, 6). Landing
P13 first is recommended for every phase, since all phases commit to `main` and touch
`src/session/**`.
