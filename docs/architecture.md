# Architecture

Status: **Accepted** (v0).

## 1. Layers

```
┌──────────────────────────── application (developer) ─────────────────────────────┐
│ HTTP routes / TUI / workers · auth · chat list · Postgres/JSON/S3 adapters        │
└──────────────┬───────────────────────────────────────────────────────▲────────────┘
               │ defineHarnessAgent(), agent.session(id).send()         │ UIMessageStream
┌──────────────▼──────────────────── eharness core ─────────────────────┴────────────┐
│ agent      config, boot validation, option bounds, session cache                 │
│ plugin     definePlugin, wrapPlugin, setup/session phases, hooks, services       │
│ registry   instructions · tools · skills · data parts · message kinds · sources  │
│ session    send/respond/regenerate/edit/attach/abort/inject/compact, lock, load, │
│            persist, pending (approvals, client tools, external waits), rewinds,  │
│            steer/queue, durable inbox, crash recovery, invariants                │
│ loop       manual step loop (1 streamText per step), stop rules, progress guard  │
│ models     model catalog lookup, models.dev adapter, cost, budgets, ledger       │
│ stream     createUIMessageStream, namespaced writers, turn buffer, stream log    │
│ messages   HarnessUIMessage, metadata, ids (UUIDv7), projection, validation      │
│ compaction token accounting, fixed summarize algorithm, guard, sanitize          │
│ skills     Skill, SkillSource, load_skill / read_skill_file                      │
│ judge      createJudge: the shared LLM judge engine (guard, permissions auto)    │
│ output     structured final answers (`send(…, { output })`)                      │
│ internal   leaf helpers: glob, regex safety, private hosts, hook runner, observe │
└──────────────┬─────────────────────────────────────────────────────────────────────┘
               │ public API only (src/index.ts)
┌──────────────▼───────── shipped extensions (same package, subpaths) ──────────────┐
│ filesystem (+ /memory, /node)   FileSystem contract, plugin, disk and mounts     │
│ shell · permissions · subagent · ask · web (+ /node)     coding-agent blocks     │
│ storage/memory   in-memory messages, state, inbox, budget ledger, stream log     │
│ mcp · openapi    tool sources                                                    │
│ todos · memory · guard · group       reference plugins                           │
│ providers · connectors               profiles, secrets, setup flows, OAuth       │
│ activity · http · client (+ /react)  feed, attention queue, routes, browser side │
│ testing          conformance suites + mock helpers                               │
└──────────────┬─────────────────────────────────────────────────────────────────────┘
               │
┌──────────────▼──────────── AI SDK v7 (peer) ─────────────────────────────────────┐
│ streamText · tool · toolSearch · UIMessage · createUIMessageStream ·              │
│ toUIMessageStream · convertToModelMessages · validateUIMessages · @ai-sdk/mcp     │
└────────────────────────────────────────────────────────────────────────────────────┘
```

Dependency direction is strictly downward. Core never imports a subpath module. Subpath modules
import core only through `src/index.ts` (the exceptions are listed in `scripts/check-imports.ts`:
`connectors` reuses `providers`, `http` reuses `activity`, `client` imports types of `http` and
`activity`, and `testing` imports `activity` and `http`).

### 1.1 Source map (`src/`)

| Folder | Holds |
|---|---|
| `index.ts`, `errors.ts`, `codes.ts` | the public core barrel, `HarnessError` and its helpers, the error / warning / stop code unions |
| `agent/` | `define-agent.ts` (boot: normalize, order plugins, validate, bounds-check options), `types.ts` (`HarnessAgentConfig`, `HarnessAgent`), `session-types.ts` (`HarnessSession`, adapters, `SendOptions`), `sessions.ts` (the session cache), `internals.ts` |
| `plugin/` | `definePlugin`, `wrapPlugin`, hook and context types |
| `registry/` | static and turn registries, tool sources, request tools, external tools, output limits, risk traits, the tool inventory |
| `skills/` | `defineSkill`, frontmatter parsing, skill sources, `load_skill` / `read_skill_file` |
| `messages/` | message and metadata types, ids, data parts, kinds, projection, sanitize, validation, pending state, framing of untrusted text |
| `models/` | catalog lookup, cost, token estimates, model-call observation |
| `compaction/` | summarize algorithm, prune, guard, flush, overflow recovery, thrash detection |
| `loop/` | the step loop: `steps.ts` drives one turn; each step is split into `step-build`, `step-input`, `step-call`, `step-settle`, `step-decide` (+ `step-ctx`, `step-events`, `step-files`, `step-guards`, `step-settings`), plus `progress`, `stop`, `usage`, `ledger`, `prompt` |
| `stream/` | the run object (`run.ts`), writers, `handleChatRequest`, stream log writer and reader, error description |
| `session/` | `session.ts` assembles a live session from `handle/` (the public API split into `api-session`, `api-turns`, `api-read`, `open`, `queue`, `inbox`), `turn/` (the turn lifecycle as phase functions: `prepare`, `commit`, `body`, `stream`, `end`, `heartbeat`, `output`, `inbox`) over one explicit state object, `interaction/` (approvals, pending, external waits, rewind, notes), `inbox/` (collect, dedupe, retry, driver), `events`, `hooks`, `invariants`, `recover`, `remote-abort`, `peek`, `load-context` |
| `judge/` | `createJudge` and its restricted transcript renderer (ADR-0060) |
| `output/` | structured final answers (tool mode and native mode) |
| `internal/` | leaf helpers with no upward imports: `glob`, `path-segments`, `regex-safety`, `private-host`, `hook-run`, `observe`, `model`, `provider-errors`, `ai-types`, `util` (`errorText`, `isRecord`) |
| `filesystem/`, `storage/`, `mcp/`, `todos/`, `memory/`, `guard/`, `group/`, `openapi/`, `ask/`, `permissions/`, `shell/`, `subagent/`, `web/`, `providers/`, `connectors/`, `activity/`, `http/`, `client/`, `testing/` | one folder per subpath module, see the table in section 2 |

### 1.2 Import rules and the core DAG

`bun run check:imports` runs two scripts. `scripts/check-imports.ts` enforces the subpath rules
(core only through `src/index.ts`, no `Bun.` and no `node:` outside the Node-only modules, no Node
globals in runtime-neutral files, no test kits in production files, the stricter `src/client` rule
that runtime imports are limited to `ai`). `scripts/check-cycles.ts` (`bun run check:cycles`)
builds the folder graph of the core from non-test files, ignores type-only imports and fails on
any cycle. The core is layered; a folder imports only from layers below it:

```
7  agent
6  session
5  compaction · loop
4  registry
3  models · plugin · stream · output · judge
2  messages · skills
1  errors (and codes)
0  internal
```

(`skills` and `messages` import only `errors` and `internal`; `models` adds `messages`; `registry`
adds `models` and `skills`; `compaction` and `loop` sit on `registry`, and `loop` also uses
`output` and `stream`; `session` uses `compaction`, `loop`, `output`, `registry`, `skills` and
`stream`; `agent` uses `session`, `registry` and `plugin`.) Hook running, token estimates, text
truncation and model-call observation live in the lowest layer that needs them, so no folder
reaches "up" the stack and module initialisation order stays predictable.

## 2. Package & exports

`eharness/filesystem/node`, `eharness/shell` and `eharness/web/node` are **Node-only**: they import
`node:` built-ins, run on Node >= 22 and Bun, and are the only paths allowed to
(`scripts/check-imports.ts` `nodeOnly`, ADR-0036). The core and every other subpath stay
runtime-neutral. All shipped modules must serve the three deployment profiles (ADR-0034).

One npm package, `eharness`, ESM-only, built with tsdown (ADR-0007). The exact runtime exports of
every entry are a committed snapshot, `scripts/exports.snapshot.json`, derived from
`package.json#exports` (`bun run check:exports`; update with `bun scripts/exports-snapshot.ts
--write`, and review the diff). Stability per entry: [API stability](engineering/api-stability.md).

| Import | Source | Contents |
|---|---|---|
| `eharness` | `src/index.ts` | `defineHarnessAgent`, `definePlugin`, `wrapPlugin`, `defineSkill`, `defineSkillSource`, `defineToolSource`, `defineDataPart`, `defineMessageKind`, `handleChatRequest`, `handleResumeRequest`, `externalTool`, `withToolExecute`, `withToolFields`, `toolTraits`, `createJudge`, `judgeCoordinator`, `observeModel`, `modelsDevCatalog`, `openRouterCatalog`, `lookupModel`, `computeCost`, `estimateStepCostUsd`, `HarnessError` and helpers (`isHarnessError`, `errorText`, `isRecord`), `uuidv7`, `isPrivateHost`, `untrustedContent`, `messageToChunks`, stored-text constants, types |
| `eharness/filesystem` | `src/filesystem/index.ts` | `FileSystem` contract, `filesystem()` plugin, `fsSkillSource()`, `projectInstructions()` / `loadProjectInstructions()`, checkpoints (`checkpointedFs()`, `inMemoryCheckpointStore()`, `rewindFiles()`, `checkpointsSince()`), binary helpers (`looksBinary()`, `detectMediaType()`, `isFileMediaRef()`), `normalizePath()`, `compileGlob()`, `contentVersion()` / `bytesVersion()`, adapter helpers (`splitLines()`, `statelessPattern()`, `classifyToolResult()`) |
| `eharness/filesystem/memory` | `src/filesystem/memory.ts` | `inMemoryFs()` |
| `eharness/filesystem/node` | `src/filesystem/node.ts` | `diskFs()`, `mountFs()`, `nodeWorkspace()`, `nodeCheckpointStore()`, `nodeRealpath()`, `nodeContainsProtected()`, `compileIgnore()` (Node-only, ADR-0036) |
| `eharness/web` | `src/web/index.ts` | `webFetch()`, `webSearch()`, `WEB_FETCH_TOOL`, `WEB_SEARCH_TOOL` (spec 22) |
| `eharness/web/node` | `src/web/node.ts` | `nodeResolveHost()`, the DNS resolver for `webFetch` (Node-only, ADR-0036) |
| `eharness/shell` | `src/shell/index.ts` | `shell()` plugin (`bash`, `bash_output`, `kill_shell`, the `shellTasks` service), `localSandbox()`, `detectOsSandbox()`, `killAllSandboxProcesses()`, `capOutput()`, `SAFE_ENV_NAMES` (Node-only, ADR-0036) |
| `eharness/permissions` | `src/permissions/index.ts` | `permissions()`, `createPermissionEngine()`, `parseRule()` / `matchRule()`, `domainSpecifierMatches()`, `isReadOnlyCommand()`, `modelClassifier()`, `PERMISSION_MODES`, `DEFAULT_PROTECTED_PATHS`, `DEFAULT_TOOL_KINDS` (spec 18) |
| `eharness/subagent` | `src/subagent/index.ts` | `subagent()` (approvals `'inline'` / `'park'` / `'policy'`, background children), `subagentChild()`, `pendingSubagentApprovals()`, `reconcileSubagentWaits()`, `reconcileBackgroundChildren()`, tool-name and `SUBAGENT_*` text constants (spec 20, ADR-0035) |
| `eharness/ask` | `src/ask/index.ts` | `ask()`, `pendingQuestions()`, `answerOutput()`, `ASK_TOOL` (spec 21) |
| `eharness/storage/memory` | `src/storage/memory.ts` | `inMemoryMessages()`, `inMemoryState()`, `inMemoryInbox()`, `inMemoryBudgetLedger()`, `inMemoryStreamLog()` |
| `eharness/mcp` | `src/mcp/index.ts` | `mcpServerSource()`, `remoteMcpSource()`, `listRemoteMcpTools()`, `bearerAuthProvider()`, `clearMcpPins()` (optional peer `@ai-sdk/mcp`) |
| `eharness/todos` | `src/todos/index.ts` | `todos()` plugin, `latestTodos()`, `openTodos()`, `renderTodos()`, `TODO_TOOL` |
| `eharness/memory` | `src/memory/index.ts` | `memory()` plugin, `executeMemoryCommand()`, `MEMORY_TOOLS`, `MEMORY_FLUSH_TOOLS` |
| `eharness/guard` | `src/guard/index.ts` | `guard()` (a wrapper over the core `createJudge` engine, ADR-0060), `GUARD_*` denial texts (spec 15) |
| `eharness/group` | `src/group/index.ts` | `group()`, `routeGroupMessage()` (spec 16) |
| `eharness/openapi` | `src/openapi/index.ts` | `openApiSource()` (spec 17) |
| `eharness/providers` | `src/providers/index.ts` | `createProviderManager()`, `defineProvider()`, `openRouterProvider()` / `gatewayProvider()` / `openAIProvider()` / `anthropicProvider()` / `openAICompatibleProvider()`, `formSpec()` / `ehMeta()`, `redactProfile()` / `redactSettings()`, `inMemoryProfileStore()`, `sealedProfileStore()`, `plaintextVault()` / `webCryptoVault()`, `fromEnv()`, `loadModelsDev()` / `loadOpenRouterModels()` (spec 23) |
| `eharness/connectors` | `src/connectors/index.ts` | `createConnectorService()`, `defineConnector()`, `activateConnectors()`, `startFlow()` / `advanceFlow()` / `completeOAuth()`, `createCredentialManager()`, `builtinConnectors()`, `remoteMcpConnector()`, `inMemoryConnectionStore()` and the other in-memory stores (spec 24) |
| `eharness/activity` | `src/activity/index.ts` | `activity()`, `inMemoryActivityStore()`, `handleActivityStream()`, `activityStream()`, `readActivityPage()`, `listAttention()`, `answerAttention()` (spec 25) |
| `eharness/http` | `src/http/index.ts` | `createHarnessHttp()`, `openAccess`, wire types (spec 26, ADR-0059) |
| `eharness/client` | `src/client/index.ts` | `createHarnessClient()`, `createHarnessTransport()`, `createChatSession()`, `createActivityFeed()`, `createAttentionList()`, `followSessionStream()`, `describeChatError()`, `HarnessHttpError` (spec 27, ADR-0059); runtime imports only `ai` |
| `eharness/client/react` | `src/client/react.ts` | `createReactBindings(React)`, `chatBridgeOf()` (no import of `react`) |
| `eharness/testing` | `src/testing/index.ts` | `scriptedModel()`, `scriptedProvider()`, `schemaCheckedMessages()`, `assertValidUIMessage()`, `assertStoredSessionInvariants()`, and the conformance suites (`messageAdapterConformance()`, `stateAdapterConformance()`, `inboxAdapterConformance()`, `lockConformance()`, `streamLogConformance()`, `multiInstanceConformance()`, `budgetLedgerConformance()`, `fileSystemConformance()`, `skillSourceConformance()`, `idGeneratorConformance()`, `activityStoreConformance()`, `httpConformance()`, and the provider and connector store suites) |

Peer dependencies: `ai@^7.0.137`, `zod@^3.25.76 || ^4.1.8` (we import from `zod/v4`). Optional
peer: `@ai-sdk/mcp@^2.0.73`. No runtime dependencies. The floors are the locked, tested versions
(`bun.lock`): the core imports values (`StreamProviderError`, `toolSearch`, …) that early 7.0.x
releases lack, and UI chunk order is public API — the golden streams are recorded with the locked
`ai` (7.0.123 orders the transient `data-eh.status { state: 'tool' }` chunk differently), so the
floor moves with the lockfile.

## 3. Lifecycles

### 3.1 Boot — `defineHarnessAgent(config)` (synchronous, no I/O)

```
normalize config (root plugin from top-level tools/skills/instructions/dataParts/kinds/mcp)
→ order plugins: [root, ...config.plugins]
→ run every plugin.setup(agentCtx)            (pure, sync)
→ build static registries: data parts, message kinds, services (provides/requires),
  static tools, static skills, static instructions
→ validate: duplicate names, reserved prefixes, missing required services,
  plugin name rules, schema presence, numeric option bounds → throws HarnessError(EH_*) on conflict
→ return HarnessAgent (frozen config + registries + empty session cache)
```

### 3.2 Session open — `agent.session(id, options?)`

Returns the cached live session for `id` if present (hot), otherwise creates one lazily. Nothing
is read from storage until the first operation that needs it (or `session.ready()`).

```
first use / ready():
  state = stateAdapter.get(id)                    (1 read, may be null)
  for plugin of ordered plugins: await plugin.session(sessionCtx)   (I/O allowed)
     → services, tools, tool sources, skills, skill sources, instructions, hooks, dispose
  resolve (ctx) => Tool inputs (all services now exist)
  tool sources: open(); `connect: 'eager'` MCP servers connect here
  hook session.start
```

Dynamic sources (`refresh: 'session'` and `'turn'`) are listed at the start of a turn, never at
open, so a slow or failing source never breaks session open (spec 02 §5).

### 3.3 Turn — `send` / `respond` / `regenerate` / `edit` / wake (spec 05 §3 is normative)

```
sync:  running flag (EH_SESSION_BUSY, or ifBusy queue/steer) → turnId → return HarnessRun
async (inside createUIMessageStream.execute):
  preparation (nothing persisted on failure):
    acquire optional lock · open session if needed
    load context (cold) or validate cache via adapter.lastId (reload state + messages on mismatch)
    active-turn check (live foreign turn → EH_SESSION_BUSY; stale → recover at commit)
    operation checks: respond ↔ state.core.pending · onNewInput deny/reject · rewind target
    validate callOptions + toolsContext · resolve dynamic sources → TurnRegistry
    normalize input (only text/file parts, rebuild metadata.eharness) · hook input.submit
    hook turn.prepare (model, settings, active tools)
    ids with per-session floor: rewind, notices, user, assistant → write start
      (respond: continue the pending message via originalMessages, same id)
  commit point (committed = true):
    one state write: recover stale turn + activeTurn + consume/deny pending (setIf when available)
    save patched pending message · save eh.rewind (regenerate/edit) · save user message
  hook turn.start · pre-turn compaction check (spec 06)
  loop steps (§3.4)
  answer dangling tool calls (every stop except tool-pending)
  write message-metadata { model, usage, stop, steps, durationMs, pending? } · setOutcome · finish | abort
  ── execute returns; the rest runs in createUIMessageStream onEnd ──
  final save · pending → state · clear activeTurn · state write · turn-end event · hook turn.end
  release lock · clear running flag → run.result resolves (never rejects) · start next queued turn
```

### 3.4 Step (inside the loop)

```
deliver waiting input as data-eh.input (steers, next-step injects, hook context) → wire
  (never before step 0 of a respond continuation: its wire must end with the approval tool message)
maybe compact (mid-turn trigger, spec 06) · guard: sanitize + hard cap (spec 06 §6)
hook step.prepare → model / settings / activeTools / toolChoice / reminder / providerOptions / messages
prompt = instructions blocks + tools (toolOrder) + projected wire + turn/step reminders (spec 02 §5)
tools = registry.toolsForStep(discovered)            (tool search discoveries, spec 02 §3.3)
result = streamText({ model, instructions, messages, tools, stopWhen: isStepCount(1),
                      toolApproval, experimental_refineToolInput, timeout, streamRetries, … })
for await (chunk of toUIMessageStream({ stream: result.stream, sendStart: false,
                                        sendFinish: false, onError: uiErrorText }))
  writer.write(chunk)                                (not merge: deterministic order)
overflow before streaming? → compact + retry once (spec 06 §7)
wire.push(...await result.responseMessages) (guarded); update discovered set
await step barrier: onStepEnd (runs in AI SDK's output pipeline) updated the cache and saved the
  snapshot (persistEachStep) · heartbeat if due
price the step with the step model (models catalog, spec 12) → usage, costUsd, data-eh.usage
hook step.end; stop rules (spec 05 §3.1) → budgets ('cost-cap') · progress guard (nudge, 'stuck')
  → pending input / turn.beforeEnd may continue (bounded by idle continuations) → wrap-up step
```

The loop is manual (ADR-0002): one `streamText` call per step, so compaction, per-step persistence,
steering, cost caps, tool-search tracking and hooks run between steps.

### 3.5 Interaction (spec 11)

```
tool needs approval ──▶ stop 'tool-pending' ──▶ state.core.pending + metadata.eharness.pending
       UI answers ──▶ handleChatRequest → respond() ──▶ consume pending → patch parts
                  ──▶ continue the SAME assistant message (tools run before the next model call)
new input while pending ──▶ onNewInput 'deny' (answer as denied, then send) | 'reject'
regenerate / edit ──▶ eh.rewind marker hides a range ──▶ normal turn
input while running ──▶ ifBusy 'steer' (data-eh.input at next step boundary) | 'queue' | 'reject'
background event ──▶ inject(kind, data, { deliver, wake })
process died mid-turn ──▶ next operation recovers: dangling calls answered, stop 'interrupted'
```

## 4. Data flow

```
                    stored form                          wire form
 MessageAdapter ─▶ HarnessUIMessage[] ─▶ project() ─▶ ModelMessage[] ─▶ streamText
       ▲                 ▲                  │
       │ save (upsert)   │ createUIMessageStream onStepEnd / onEnd (the core drains the stream)
       │                 │
       └──────── assistant UIMessage ◀── UIMessageChunk stream ──▶ client (SSE / TUI / test)
```

- **Stored form** = `UIMessage` (ADR-0003). AI SDK accumulates the assistant message from the same
  chunks that reach the client, so what the user saw is what is stored.
- **Wire form** = `ModelMessage[]`. Across turns it is re-derived from stored messages by
  projection (spec 03 §6). Inside a turn the loop appends `responseMessages` directly (lossless).

## 5. Extension points

| Want to… | Use | Spec |
|---|---|---|
| Add tools/skills/instructions statically | top-level config or `plugin.setup` | 01, 02 |
| Add them dynamically (DB, per user, per turn) | `defineToolSource`, `defineSkillSource`, instruction functions | 02 |
| Share an object between plugins | `provides` / `requires` services | 01 §6 |
| Intercept tool calls, steps, turns, saves, compaction | hooks | 01 §5 |
| Send custom UI data | `defineDataPart` + `ctx.stream.data()` | 03 §4, 04 |
| Insert non-model messages (notices, events) | `defineMessageKind` + `session.inject()` | 03 §5 |
| Gate tools behind approval | `approval.policy`, `approval.risk` + tool `metadata.risk`, `tool.approve` hook | 11 §3 |
| Audit approvals / build an approval inbox | `approval.decided` hook, `TurnResult.pending`, `respond({ approvals: [{ actor }] })` | 11 §3.3 |
| Measure phases and count failures (metrics, tracing) | `observe` callback | 10 §8, [observability](guides/observability.md) |
| Put a cheap LLM in front of risky calls | `guard()` (tighten-only) or permissions auto mode, both on `createJudge` | 15, 18, [LLM judge](guides/llm-judge.md) |
| Know context windows and prices | `models` (record, function, `modelsDevCatalog`) | 12 |
| Limit spending | `budget` (USD), `loop.maxTurnOutputTokens` | 12 §4, 05 §3.1 |
| Validate / rewrite / block user input | `input.submit` hook | 01 §5 |
| Pick model/settings per turn | `SendOptions`, `callOptions`, `turn.prepare` hook | 01, 05 |
| Keep the agent going (todos, checks) | `turn.beforeEnd` hook, or `todos({ enforce: true })` | 01 §5, 05 §3.2, 13 |
| Add volatile per-step context | `step.prepare` `reminder` | 02 §5 |
| Run subagents | a tool that opens a child session (`SessionOptions.parent`), preliminary results, `addUsage` (tokens + cost) | 05 §1, 09 §5, 12 §3 |
| Store messages anywhere | implement `MessageAdapter` (2 methods) | 05 |
| Persist plugin state | `ctx.state` + `StateAdapter` | 05 |
| Store files anywhere | implement `FileSystem` | 08 |
| Load skills from anywhere | implement `SkillSource` | 07 |

## 6. Cross-cutting rules

- **Determinism of prompt prefix:** instruction and tool ordering is stable; static parts precede
  dynamic parts; skill index is sorted by name (spec 02 §6).
- **Serializable state only:** anything persisted (messages, state) is JSON. Services, clients and
  closures are rebuilt from the agent definition on session open.
- **Concurrency:** one running turn per session per process (`EH_SESSION_BUSY`, or queue/steer).
  Cross-process: best effort via `state.core.activeTurn`, exact via `SessionOptions.lock`
  (spec 05 §8–9).
- **Stored order = model order:** everything the model saw is stored where it saw it (steers as
  `data-eh.input` parts, approvals on their tool parts); history is append-only and hidden only
  by `eh.rewind` markers (ADR-0011).
- **Server-owned decisions:** clients send input and answers only; pending ids, message ids and
  metadata are server-owned (spec 11 §8).
- **Bounded waits:** nothing the core awaits can hang a turn: hooks, model streams, MCP connects,
  tool source listings and OAuth requests all have default time limits (`hooks.timeoutMs`,
  `settings.timeout`, `toolSources.timeoutMs`, ...).
- **Errors:** boot conflicts throw; turn operations throw only `EH_SESSION_BUSY` / `EH_SESSION_CLOSED`;
  every other turn failure ends the turn with `stop: 'error'` and never rejects `run.result`
  (spec 05 §2, spec 10).

## Providers and connectors share one config layer

Both are rows of one profile table (`config_profiles`), sealed by one `SecretVault` through one
`sealedProfileStore`, redacted and patched with the same `redactProfile` / `mergeSecretPatch`, and
invalidated across instances by one poller of the event feed. They stay separate areas in a UI
(model providers are admin infrastructure picked per agent; connectors are a per-agent tool
directory), as in Dify (Model Provider settings vs. tool plugins) and LibreChat (endpoints vs. MCP
servers); they share the building blocks. See ADR-0053.
