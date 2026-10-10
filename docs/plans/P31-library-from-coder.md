# P31 — Library improvements found by the coding-agent benchmark

Status: done (shipped in 0.7.0) · Owner: — · Branch: `main` (direct commits)

## Goal

`examples/coder` (P30) exists to test whether eharness meets its goal: building a real agent
product with only the public API. Every workaround it needed is a finding about the library. This
phase turns those findings into library changes: correctness fixes and missing core APIs first,
then shipped plugins/subpaths promoted from code the example proved, then the larger items that
need an ADR. After each item the example drops its workaround and uses the library.

Source: "Requests to the library" R1–R20 in [P30](P30-coder-example.md), plus the two bugs found
in real use (2026-10-08).

## Already done

| Item | Shipped as |
|---|---|
| R21: `session.compact()` had no options, so a short conversation never compacted and `/compact <focus>` needed a `compaction.prompt` plugin workaround | `compact({ keepLast?, instructions? })` (type `CompactOptions`; spec 05 §2, spec 06 §4); the coder's `/compact` uses `keepLast: 0` and drops `compact-focus.ts` |
| Continuation streams kept answered calls in `approval-requested` (real-use bug: an approved long-running tool looked like it still waited) | 0.6.1 patch: `tool-approval-response` chunks at the start of a `respond()` continuation (spec 04 §2, spec 11 §4) |

## Classification rule

Core when every non-trivial agent app hits it and it cannot be built outside the core (it needs
turn internals). A shipped plugin/subpath when it is generic (at least the coder example and one
other product shape need it) and buildable on the public API (ADR-0008 dogfooding). Example-only
when it is product policy (the coder's permission UX, slash commands, settings files).

## L1 — core API gaps (small, every app hits them)

| # | Change | Why (example workaround today) | Spec |
|---|---|---|---|
| R16 | **Done** (`respond({ approvals: [{ id, approved, note }] })`): `PendingResponse.approvals[].note?: string`: delivered to the model on the continuation's first step, right after the tool results (a `<user-note>` framed text in the trailing tool/user message) | the app steers the note after `respond()`, so the model reads it one call late, and carries undelivered notes forward | 11 §4 |
| R17 | **Done** (`respond(…, { endTurn: 'after-answers' | 'if-denied' })`): `respond(…, { endTurn: 'after-answers' })` (or `stopOnDeny`): record the answers and end the turn without a model step | the app tees the stream and aborts on the first `tool-output-denied`; one model request may already start | 11 §4 |
| R18 | **Done** (`PendingState.clientTools[].input` (+ `inputTruncated`)): `PendingState.clientTools[].input` (size-capped) | the app re-reads the stored tool part to get the question input | 11 §2 |
| R19 | **Done** (`run.delivery` (`'step' | 'turn' | 'dropped'`, type `SteerDelivery`)): `send(input, { ifBusy: 'steer' })` reports the outcome: `run.delivery: Promise<'step' \| 'turn' \| 'dropped'>` (or a `steer-delivered` / `input-dropped` event with the input's client id) | the controller infers it from `attach()` and `input-dropped` events (`ActiveTurn` bookkeeping) | 05 §2, §12 |
| R14 | **Done** (`session.tools()` → `SessionToolInfo[]` (`name, description?, inputSchema, source, deferred, tokens`)): `session.tools(): Promise<Array<{ name, description, inputSchema, source, deferred }>>` (resolved per session/turn, same order as the request) | `/context` reads plugin internals (`~def`) to itemise tool sizes | 02 §3 |
| R15 | **Done** (`ContextStats.instructionBlocks` and `ContextStats.toolSources`): `ContextStats.instructionBlocks: Array<{ owner, tokens }>` (per plugin / app block) and `tools` per source | the app estimates memory/skills/MCP itself | 06 §2 |
| R20 | **Done** (`providerMetadata.eharness.durationMs` on every `reasoning-end` chunk): Reasoning timing: `metadata.eharness.steps[i].reasoningMs` or a transient `data-eh.reasoning { ms }` per reasoning part | stored reasoning shows no duration | 04 §2 |
| R8 | **Done** (`TurnInfo.addUsage()` accepts `PlainUsage` (types `AddUsageInput`, `PlainUsage`)): `ctx.turn.addUsage()` accepts `TurnResult['usage']` (plain token counts) | a conversion helper in the agent tool | 01 §4 |
| R13 | **Done** (`ERROR: <message>` adapter errors, option `onAdapterError`): `filesystem({ formatAdapterError })` / default: adapter exceptions become `ERROR: <message>` strings | binary/large-file reads reach the model as `Error: …` | 08 §3 |
| R12 | **Done** (`config.toolOrder` (+ warning `W_TOOL_ORDER`)): `toolOrder` option (explicit order of final tool names; others after) | root tools always precede plugin tools | 02 §6 |
| R11 | **Done** (`StepPrepareEvent.continuing?: { approved, denied }`): `step.prepare` event gains `continuing?: { approved: string[] }` for step 0 of a continuation | `endsWithApprovedPlan` inspects the wire | 01 §5 |

## L2 — promote proven example code to shipped modules

| # | Module | From the example | Notes |
|---|---|---|---|
| R2, R3 | **Done** (`edit_file` `edits[]`, `glob` tool, `compileGlob`): `eharness/filesystem`: `edit_file` with `edits: [{ old_string, new_string, replace_all? }]` (atomic, one read check) and a `glob` tool | `workspace/glob-tool.ts`; the model's repeated edits | spec 08 change, model-visible texts |
| R4 | **Done** (`eharness/filesystem/node`: `diskFs()`, `mountFs()`, `nodeWorkspace()`, `nodeCheckpointStore()`, `compileIgnore()`; spec 08 §8, ADR-0036): `diskFs(root)` with realpath containment, gitignore subset, mode-preserving atomic writes, `rg` grep fast path | `workspace/disk-fs.ts`, `guard.ts`, `mount-fs.ts` | first Node-only module (runtime rule 3 relaxed per subpath) |
| R5 | **Done** (`eharness/shell`: `shell()` with `bash` / `bash_output` / `kill_shell`, `localSandbox()` with Seatbelt / bubblewrap, `shellTasks` service; spec 19): bash tool over AI SDK sandbox sessions, process-group cleanup, background shells | `shell/**`, `app/background-bash.ts` | Node-only; roadmap "Sandbox plugin" |
| R6 | **Done** (`eharness/subagent`: `subagents({ agents, maxDepth, maxConcurrent, background, approvals })`, `pendingSubagentApprovals()`; spec 20): progress, usage and approvals through a caller-supplied `answer` (inline), policy or park | `agents/agent-tool.ts`, `agents/drive.ts` | roadmap "Subagents plugin" |
| R7 | **Done** (`eharness/permissions`: `permissionsPlugin()`, `createPermissionEngine()`, `parseCommand()`; spec 18): rule engine (`Tool(spec)` allow/ask/deny, modes incl. plan, shell command parsing with containment); the UI stays in the app | `permissions/**` | spec + guide |
| — | **Done** (`eharness/ask`: `askUser()`, `pendingQuestions()`, `answerOutput()`; spec 21): `ask_user_question` client tool with a non-interactive fallback | `agents/ask-tool.ts` | small plugin |
| — | **Done** (`eharness/web`: `webFetch()` with an injectable `toMarkdown`, `webSearch()`; spec 22): SSRF guards, same-host redirects, no new dependency | `app/web-tools.ts` | converter is injectable (no dependency) |
| — | **Done** (`checkpointedFs()`, `memoryCheckpointStore()`, `nodeCheckpointStore()`, `rewindFiles()`, `checkpointsSince()`; spec 08 §11): snapshots before the first change per turn, rewind | `app/checkpoints.ts` | pairs with `session.fork()` (done) |

## L3 — larger items (ADR first)

| # | Item |
|---|---|
| R1 | **Done** (ADR-0035, spec 20 §3: `subagents({ approvals: 'park' })`, `subagentChild()`, `reconcileSubagentWaits()` / `selfAgent` for crash recovery): nested approvals across processes: the parent parks as an external wait while a child session waits for a person |
| R9 | **Done** (`FileSystem.readBytes` / `writeBytes`, `FileMeta.binary`, `read_file` media outputs with stored `media-ref`, binary skill assets; spec 08 §12, spec 06 §2): binary files / images in `FileSystem` and file parts to the model |
| R10 | Parent/child session index (`session.children()`), child session id on the agent tool's final output — **core done** (`children()`, `parentInfo()`, spec 05 §13, ADR-0037); the child id is in the wait payload and `data-subagent.run` (spec 20) |
| — | `session.fork(beforeMessageId?)` in core (rewind conversation, branch) — **done** (spec 05 §14, ADR-0037) |

## Order

L1 first (one minor release, each item with spec text, tests and a changeset), then the example
switches to the new APIs; then L2 modules one by one (each: spec, ADR where noted, conformance
or golden tests, the example imports the module instead of its own code); L3 after a design
review.

## Open questions

1. ~~L2 R7: shipped as `eharness/permissions`.~~ Resolved.
2. ~~L2 `eharness/web`: ship `turndown`?~~ Resolved: an injectable `toMarkdown` converter, no dependency.
3. Auto mode (permissions spec 18 §12): decisions taken conservatively, to revisit. (a) Protected-path
   writes ask a person in `auto` (Claude Code routes them to its classifier). (b) A classifier
   error counts as a block toward the pause thresholds. (c) `setMode('auto')` without a classifier
   throws instead of falling back to `default`. (d) The classifier's token usage is not charged to
   the turn (`approvalGuard` does charge its judge); `modelClassifier` has no `onUsage` yet.
   (e) Broad allow rules are ignored in auto (`Bash(*)`, wildcarded interpreters) like Claude Code,
   decided by a heuristic on the rule text. (f) Claude Code's subagent spawn/result review is not
   implemented.
