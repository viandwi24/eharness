# P31 — Library improvements found by the coding-agent benchmark

Status: todo · Owner: — · Branch: `main` (direct commits)

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
| Continuation streams kept answered calls in `approval-requested` (real-use bug: an approved long-running tool looked like it still waited) | 0.6.1 patch: `tool-approval-response` chunks at the start of a `respond()` continuation (spec 04 §2, spec 11 §4) |

## Classification rule

Core when every non-trivial agent app hits it and it cannot be built outside the core (it needs
turn internals). A shipped plugin/subpath when it is generic (at least the coder example and one
other product shape need it) and buildable on the public API (ADR-0008 dogfooding). Example-only
when it is product policy (the coder's permission UX, slash commands, settings files).

## L1 — core API gaps (small, every app hits them)

| # | Change | Why (example workaround today) | Spec |
|---|---|---|---|
| R16 | `PendingResponse.approvals[].note?: string`: delivered to the model on the continuation's first step, right after the tool results (a `<user-note>` framed text in the trailing tool/user message) | the app steers the note after `respond()`, so the model reads it one call late, and carries undelivered notes forward | 11 §4 |
| R17 | `respond(…, { endTurn: 'after-answers' })` (or `stopOnDeny`): record the answers and end the turn without a model step | the app tees the stream and aborts on the first `tool-output-denied`; one model request may already start | 11 §4 |
| R18 | `PendingState.clientTools[].input` (size-capped) | the app re-reads the stored tool part to get the question input | 11 §2 |
| R19 | `send(input, { ifBusy: 'steer' })` reports the outcome: `run.delivery: Promise<'step' \| 'turn' \| 'dropped'>` (or a `steer-delivered` / `input-dropped` event with the input's client id) | the controller infers it from `attach()` and `input-dropped` events (`ActiveTurn` bookkeeping) | 05 §2, §12 |
| R14 | `session.tools(): Promise<Array<{ name, description, inputSchema, source, deferred }>>` (resolved per session/turn, same order as the request) | `/context` reads plugin internals (`~def`) to itemise tool sizes | 02 §3 |
| R15 | `ContextStats.instructionBlocks: Array<{ owner, tokens }>` (per plugin / app block) and `tools` per source | the app estimates memory/skills/MCP itself | 06 §2 |
| R20 | Reasoning timing: `metadata.eharness.steps[i].reasoningMs` or a transient `data-eh.reasoning { ms }` per reasoning part | stored reasoning shows no duration | 04 §2 |
| R8 | `ctx.turn.addUsage()` accepts `TurnResult['usage']` (plain token counts) | a conversion helper in the agent tool | 01 §4 |
| R13 | `filesystem({ formatAdapterError })` / default: adapter exceptions become `ERROR: <message>` strings | binary/large-file reads reach the model as `Error: …` | 08 §3 |
| R12 | `toolOrder` option (explicit order of final tool names; others after) | root tools always precede plugin tools | 02 §6 |
| R11 | `step.prepare` event gains `continuing?: { approved: string[] }` for step 0 of a continuation | `endsWithApprovedPlan` inspects the wire | 01 §5 |

## L2 — promote proven example code to shipped modules

| # | Module | From the example | Notes |
|---|---|---|---|
| R2, R3 | `eharness/filesystem`: `edit_file` with `edits: [{ old_string, new_string, replace_all? }]` (atomic, one read check) and a `glob` tool | `workspace/glob-tool.ts`; the model's repeated edits | spec 08 change, model-visible texts |
| R4 | `eharness/filesystem/node`: `diskFs(root)` with realpath containment, ignore rules, mode-preserving atomic writes, `rg` grep fast path | `workspace/disk-fs.ts`, `guard.ts`, `mount-fs.ts` | first Node-only module: ADR (runtime rule 3) |
| R5 | `eharness/shell`: bash tool over AI SDK `Experimental_SandboxSession` (local driver, OS sandbox driver: Seatbelt / bubblewrap), process-group cleanup, background shells | `shell/**`, `app/background-bash.ts` | Node-only; "Sandbox plugin" roadmap row; ADR |
| R6 | `eharness/subagent`: `subagentTool({ agents, depth, concurrency, background? })` with progress, usage, approvals driven through a caller-supplied answerer | `agents/agent-tool.ts`, `agents/drive.ts` | roadmap "Subagents plugin" |
| R7 | `eharness/permissions`: rule engine (`Tool(spec)` allow/ask/deny, modes incl. plan, shell command parsing with containment) as a plugin | `permissions/**` | big surface: spec + ADR; keep the UI out |
| — | `eharness/ask`: `askUserQuestionTool()` (client tool) + answer formatting | `agents/ask-tool.ts` | small plugin |
| — | `eharness/web`: `webFetchTool()` (SSRF guards, same-host redirects, Markdown) | `app/web-tools.ts` | needs an HTML→Markdown dependency: ADR or injectable converter |
| — | Filesystem checkpoints: `filesystem({ checkpoints })` snapshots before the first change per turn + `rewindFiles()` | `app/checkpoints.ts` | pairs with a core `session.fork(beforeMessageId)` (roadmap "Fork") |

## L3 — larger items (ADR first)

| # | Item |
|---|---|
| R1 | Nested approvals across processes: park a parent turn while a child session waits for a person |
| R9 | Binary files / images in `FileSystem` and file parts to the model |
| R10 | Parent/child session index (`session.children()`), child session id on the agent tool's final output |
| — | `session.fork(beforeMessageId?)` in core (rewind conversation, branch) |

## Order

L1 first (one minor release, each item with spec text, tests and a changeset), then the example
switches to the new APIs; then L2 modules one by one (each: spec, ADR where noted, conformance
or golden tests, the example imports the module instead of its own code); L3 after a design
review.

## Open questions

1. L2 R7: is a permission engine generic enough for core users (server products use `approval`
   policies), or should it stay an example with only the shell-command parser shipped?
2. L2 `eharness/web`: ship `turndown` as an optional peer, or take a converter function?
