# Architecture

Status: **Accepted** (v0).

## 1. Layers

```
┌──────────────────────────── application (developer) ─────────────────────────────┐
│ HTTP routes / TUI / workers · auth · chat list · Postgres/JSON/S3 adapters        │
└──────────────┬───────────────────────────────────────────────────────▲────────────┘
               │ defineHarnessAgent(), agent.session(id).send()         │ UIMessageStream
┌──────────────▼──────────────────── eharness core ─────────────────────┴────────────┐
│ agent      config, boot validation, session cache                                │
│ plugin     definePlugin, setup/session phases, hooks, services                   │
│ registry   instructions · tools · skills · data parts · message kinds            │
│ session    send/respond/regenerate/edit/attach/abort/inject/compact, lock, load, │
│            persist, pending, rewinds, steer/queue, crash recovery                │
│ loop       manual step loop (1 streamText per step), stop rules, progress guard  │
│ models     model catalog lookup, models.dev adapter, cost, budgets               │
│ stream     createUIMessageStream, namespaced writers, turn buffer                │
│ messages   HarnessUIMessage, metadata, ids (UUIDv7), projection, validation      │
│ compaction token accounting, fixed summarize algorithm, guard, sanitize          │
│ skills     Skill, SkillSource, load_skill / read_skill_file                      │
└──────────────┬─────────────────────────────────────────────────────────────────────┘
               │ public API only (src/index.ts)
┌──────────────▼───────── shipped extensions (same package, subpaths) ──────────────┐
│ eharness/filesystem         FileSystem contract, filesystem() plugin, file tools │
│ eharness/filesystem/memory  memoryFs()                                           │
│ eharness/storage/memory     memoryMessages(), memoryState()                      │
│ eharness/mcp                mcpServer() tool source over @ai-sdk/mcp             │
│ eharness/todos              todos() plugin: todo_write, data-todos.list          │
│ eharness/memory             memory() plugin: memory files under app roots        │
│ eharness/testing            conformance suites + mock helpers                    │
└──────────────┬─────────────────────────────────────────────────────────────────────┘
               │
┌──────────────▼──────────── AI SDK v7 (peer) ─────────────────────────────────────┐
│ streamText · tool · toolSearch · UIMessage · createUIMessageStream ·              │
│ toUIMessageStream · convertToModelMessages · validateUIMessages · @ai-sdk/mcp     │
└────────────────────────────────────────────────────────────────────────────────────┘
```

Dependency direction is strictly downward. Core never imports a subpath module. Subpath modules
import core only through `src/index.ts`.

## 2. Package & exports

One npm package, `eharness`, ESM-only, built with tsdown (ADR-0007).

| Import | Source | Contents |
|---|---|---|
| `eharness` | `src/index.ts` | core API and types |
| `eharness/filesystem` | `src/filesystem/index.ts` | `FileSystem` contract, `filesystem()` plugin, `fsSkillSource()`, helpers |
| `eharness/filesystem/memory` | `src/filesystem/memory.ts` | `memoryFs()` |
| `eharness/storage/memory` | `src/storage/memory.ts` | `memoryMessages()`, `memoryState()` |
| `eharness/mcp` | `src/mcp/index.ts` | `mcpServer()` (optional peer `@ai-sdk/mcp`) |
| `eharness/todos` | `src/todos/index.ts` | `todos()` plugin, `latestTodos()`, `openTodos()`, `renderTodos()`, fixed texts |
| `eharness/memory` | `src/memory/index.ts` | `memory()` plugin, `executeMemoryCommand()`, `MEMORY_PROTOCOL`, `MEMORY_TOOLS` |
| `eharness/testing` | `src/testing/index.ts` | `messageAdapterConformance()`, `stateAdapterConformance()`, `fileSystemConformance()`, `skillSourceConformance()`, `idGeneratorConformance()`, `scriptedModel()` |

Peer dependencies: `ai@^7.0.123`, `zod@^3.25.76 || ^4.1.8` (we import from `zod/v4`). Optional
peer: `@ai-sdk/mcp@^2.0.63`. No runtime dependencies. The `ai` floor is the tested version: the
core imports values (`StreamProviderError`, `toolSearch`, …) that early 7.0.x releases lack.

## 3. Lifecycles

### 3.1 Boot — `defineHarnessAgent(config)` (synchronous, no I/O)

```
normalize config (root plugin from top-level tools/skills/instructions/dataParts/kinds/mcp)
→ order plugins: [root, ...config.plugins]
→ run every plugin.setup(agentCtx)            (pure, sync)
→ build static registries: data parts, message kinds, services (provides/requires),
  static tools, static skills, static instructions
→ validate: duplicate names, reserved prefixes, missing required services,
  plugin name rules, schema presence                → throws HarnessError(EH_*) on conflict
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
- **Errors:** boot conflicts throw; turn operations throw only `EH_SESSION_BUSY` / `EH_SESSION_CLOSED`;
  every other turn failure ends the turn with `stop: 'error'` and never rejects `run.result`
  (spec 05 §2, spec 10).
