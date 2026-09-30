# eharness

## 0.2.0

### Minor Changes

- [#7](https://github.com/viandwi24/eharness/pull/7) [`e1e0d76`](https://github.com/viandwi24/eharness/commit/e1e0d76f2ed12d79e7f55422d515c38b7c15b37d) Thanks [@viandwi24](https://github.com/viandwi24)! - **BREAKING:** the minimum peer versions are now `ai@^7.0.123` and `@ai-sdk/mcp@^2.0.63` (the tested
  versions). eharness imports values such as `StreamProviderError` and `toolSearch` that early
  `ai` 7.0.x releases do not export; 0.1.0 already needed `ai` ≥ 7.0.104 in practice (first release exporting `toolSearch`).
  Migration: `npm install ai@^7.0.123` (and `@ai-sdk/mcp@^2.0.63` if you use `eharness/mcp`).
  
  **BREAKING (model-visible behaviour):** the built-in skill tools (`load_skill`, `read_skill_file`,
  `search_skills`) now validate their input with AI SDK. Malformed input (a missing or non-string
  field) is a tool error (`output-error` part, `step.end` status `'error'`) with AI SDK's text
  `AI_InvalidToolInputError: Invalid input for tool <tool>: …` instead of a result text
  ``ERROR: `<field>` must be a string``. Their JSON input schemas now include a `$schema` key
  (draft-07), which changes the tool definitions sent to the model once (one prompt-cache miss).
  Migration: if you match the old `ERROR: … must be a string` text, match the tool error instead.
  
  **Behaviour change:** `StepEndEvent.toolResults` is now derived from AI SDK's `StepResult`: results
  are listed in call order, and a tool whose `toModelOutput` returns `error-text` now has status
  `'output'` (it was `'error'`). Migration: to inspect the model output, read `event.step` or
  `event.responseMessages`.
  
  - Context overflow recovery now also works after AI SDK retries: a "prompt too long" rejection
    wrapped in a `RetryError` (e.g. a 429 followed by a 400, or behind a gateway error's `cause`)
    and `StreamProviderError`s with status 400/413 are recognised.
  - `describeError` uses the same classification. A `RetryError` whose last attempt has no HTTP
    status (e.g. a network error) but an earlier attempt was a 429 / 5xx now reads `Rate limited: …`
    / `Provider unavailable: …` instead of `Unexpected error (see server logs)`.
  - New: the `step.end` event exposes AI SDK's `StepResult` of the step as `step`.
  - Tool errors for invalid tool input and unknown tools now reach the UI stream and stored
    messages with the same text the model got (`AI_InvalidToolInputError: …`,
    `AI_NoSuchToolError: …`) instead of `Unexpected error (see server logs)`.
  - `DataChunk` is now derived from AI SDK's `UIMessageChunk` (same shape).

## 0.1.0

### Minor Changes

- [`d3a8deb`](https://github.com/viandwi24/eharness/commit/d3a8debd80b94208bbcbd37ec6a41568de958487) Thanks [@viandwi24](https://github.com/viandwi24)! - **eharness 0.1.0 — first public release.** Build your own agent harness on AI SDK v7:
  
  - **Agent and plugins:** `defineHarnessAgent`, `definePlugin` with services, hooks
    (`input.submit`, `turn.*`, `step.*`, `tool.*`, `message.beforeSave`, `compaction.*`,
    `skill.load`), namespaced data parts and message kinds, boot validation with `EH_*` errors.
  - **Context:** static and dynamic instructions, tools (`defineToolSource`, deferred tools with tool
    search, output limits with `truncate` / `evict`) and skills (`defineSkill`,
    `defineSkillSource`, `load_skill` / `read_skill_file` / `search_skills`), prompt-cache-friendly
    layout with turn/step reminders.
  - **Messages and streaming:** everything is a `UIMessage` (`InferHarnessUIMessage` for
    `useChat`), UUIDv7 ids, projection to the model, one AI SDK UI message stream per turn,
    `attach()` resume and `events()`.
  - **Sessions and storage:** two-method `MessageAdapter`, `StateAdapter` with optional `setIf`,
    `SessionLock`, per-step persistence, crash recovery, idle eviction; memory adapters in
    `eharness/storage/memory`.
  - **Compaction:** summarize + keep tail + guard, stored as `eh.compaction` markers, overflow
    recovery.
  - **Interaction:** tool approvals (`approval.policy`, grants, `respond()`), client-side tools,
    `regenerate()` / `edit()`, steering and queueing (`ifBusy`), `inject()` with wake-ups, and
    `handleChatRequest()` for `useChat`.
  - **Extensions:** `eharness/filesystem` (+ `memoryFs()`), `eharness/mcp` (`mcpServer()`), and
    `eharness/testing` with `scriptedModel()` and conformance suites for message, state, file
    system, skill source and id generator adapters.
  
  Changes in this release on top of the 0.0.x previews:
  
  - `scriptedModel()` also answers `doGenerate` calls (e.g. the compaction summarizer) from the same
    script, so one scripted model can drive a conversation that compacts.
  - The exported `version` constant now always equals the package version.
  - Tool functions (`tools: { x: (ctx) => tool(…) }`) get `ctx.stream.data(name, data)` typed with
    their owner's data parts: the plugin's `dataParts` for tools a plugin contributes (setup or
    session phase), the app's `dataParts` for top-level tools. `ToolInput` / `ToolsInput` and
    `HarnessAgentConfig` take the data part map as an optional type parameter (defaults keep
    existing code compiling).
  
  Stability: 0.x — breaking changes ship only in minor versions with a migration note. No public API
  is `experimental_`. Requires `ai@^7`, `zod@^3.25.76 || ^4.1.8`, Node ≥ 22 or Bun; `@ai-sdk/mcp@^2`
  is an optional peer for `eharness/mcp`.

### Patch Changes

- [`51fe06a`](https://github.com/viandwi24/eharness/commit/51fe06a1db092048c1791b00b307b5e109b97118) Thanks [@viandwi24](https://github.com/viandwi24)! - Context loading and compaction: the fixed compaction algorithm (pre-turn, mid-turn with
  `partial`, and manual `session.compact()`), rolling chunked summarization with a continuation-brief
  prompt and the `compaction.prompt` / `compaction.after` hooks, `eh.compaction` markers with a
  compaction pointer so cold loads need one `load({ fromId })` query (self-healing after lost state
  writes), calibrated token accounting (`metadata.eharness.tokens`, `session.stats()`,
  `data-eh.context` with `lastCompaction`), the complete guard (drop oldest turns, truncate the
  largest tool outputs in the request, `W_CONTEXT_TRUNCATED`, `EH_CONTEXT_OVERFLOW`), the `select`
  escape hatch, `compaction: false`, and provider overflow recovery (held-back error chunk,
  recalibration, compact-and-retry, tighter guard, `W_OVERFLOW_RETRY`, `config.isContextOverflow`).

- [`d49e337`](https://github.com/viandwi24/eharness/commit/d49e33732c38a4d404604e4ea90e4ecc7be1446f) Thanks [@viandwi24](https://github.com/viandwi24)! - Core foundations: `HarnessError` with stable `EH_*` codes, `isHarnessError`, `HarnessToolError`
  and warning codes; monotonic UUIDv7 ids (`uuidv7`, `isUuidV7`); the message model
  (`HarnessUIMessage`, `metadata.eharness`, `InferHarnessUIMessage`, stop reasons, turn results) and
  fixed model-visible texts; `defineDataPart`, `defineMessageKind`, `createKindMessage`,
  `isKindMessage` and the core `eh.*` data parts and kinds; `definePlugin` with typed hooks,
  services and a namespaced stream writer; `defineToolSource`; and `defineHarnessAgent` with the
  root plugin, synchronous setup phase and boot validation (duplicate tools/skills/data parts,
  service conflicts, missing services, plugin order, invalid names and options). `agent.session()`
  is not implemented yet. `eharness/testing` adds `idGeneratorConformance`.

- [`71bf127`](https://github.com/viandwi24/eharness/commit/71bf1279de34ee936b42fc5eca3b67fcfc7bf4bf) Thanks [@viandwi24](https://github.com/viandwi24)! - Filesystem plugin (`eharness/filesystem`, `eharness/filesystem/memory`): the `FileSystem` adapter
  contract with `normalizePath` and `contentVersion`, the in-memory `memoryFs()` adapter, and the
  `filesystem()` plugin providing the typed `fs` and `toolOutputs` services, the file tools
  `list_files`, `read_file` (line-numbered windows with `offset`/`limit`), `write_file`, `edit_file`
  (smart replace: exact, line-trimmed, whitespace-normalized; ambiguity rejected), `delete_file` and
  `grep`, with read-before-edit, `STALE:` results carrying the current content, optimistic locking
  (`CONFLICT:`), read-only/hidden prefixes, allowed extensions and undeletable files
  (`REJECTED:`), `lastRead` in plugin state, the `data-filesystem.change` part, a per-session `fs`
  resolver, and skills autoload through `fsSkillSource` (hidden skills root by default).
  `classifyToolResult` classifies tool results for UIs. `eharness/testing` adds
  `fileSystemConformance` for custom adapters. The `experimental_placeholder` exports of both
  filesystem entry points are removed.

- [`8790727`](https://github.com/viandwi24/eharness/commit/8790727ad9702a98699e1019d19b5b5ad7dc29e5) Thanks [@viandwi24](https://github.com/viandwi24)! - Interaction: `respond()` answers tool approvals and client tool calls against the server-owned
  pending state (all-or-nothing, `unknown-id` / `incomplete` / `stale` run errors, consumed in the
  commit-point state write so replays never execute anything) and continues the same assistant
  message; session approval grants (`remember: 'session'`, `clearGrants()`, `W_GRANT_IGNORED`) and a
  fail-closed approval policy; `approval.onNewInput` (`deny` / `reject` → `EH_PENDING_RESPONSE`);
  `regenerate()` and `edit()` with `eh.rewind` markers (hidden messages excluded from projection,
  compaction and `messages()`, `not-found` / `beyond-compaction`); `send(…, { ifBusy: 'steer' })`
  delivered as `data-eh.input` at the next step boundary and `ifBusy: 'queue'`; `inject()` with
  `deliver: 'next-step'` (`deliveredIn`) and `wake` (never lost; queued turns wait while approvals
  are pending); the `useChat` adapter `handleChatRequest()`.
  Client tool outputs pass through `tool.after` and output limits. Run errors carry
  `error.details` in `run.result`. Fixes automatically approved tools being executed twice.
  `EH_NOT_IMPLEMENTED` is removed from the error codes.

- [`ef5d8b9`](https://github.com/viandwi24/eharness/commit/ef5d8b991048c45f4f085819d0537aa37a282976) Thanks [@viandwi24](https://github.com/viandwi24)! - Sessions and the turn runtime: `agent.session(id)` now returns a live session (cached, idle
  eviction, `closeSession()` / `close()`). `send()` runs a multi-step turn (one `streamText` call per
  step) and returns a `HarnessRun` whose `stream` is the AI SDK UI message stream (`toResponse()`,
  `pipeTo()`, `attach()` to replay and follow a running turn); `run.result` never rejects. Turns
  persist the user message and the assistant message after every step through a `MessageAdapter`,
  keep namespaced plugin state through a `StateAdapter`, follow the normative lifecycle (lock,
  commit point, `input.submit`, `turn.prepare`, `step.prepare`, `step.end`, `turn.beforeEnd`,
  `tool.before` / `tool.after` / `tool.approve`, `message.beforeSave`), stop by the documented stop
  rules (`complete`, `tool-pending`, `max-steps`, `cost-cap`, `timeout`, `aborted`, `blocked`, …),
  answer interrupted tool calls, recover turns of crashed processes, and lay out prompts for caching
  (two stable system blocks, turn/step reminders, stable tool order, Anthropic `cacheControl`).
  Also: `session.inject()` (next-turn delivery), `messages()`, `stats()`, `events()`, `abort()`,
  `clearGrants()`. New entry points: `memoryMessages()` / `memoryState()` in
  `eharness/storage/memory`, and `messageAdapterConformance()`, `stateAdapterConformance()` and
  `scriptedModel()` in `eharness/testing`. Fix: `eh.event` payloads without `data` are valid.
  Not yet available (coming before 0.1.0): `respond()`, `regenerate()`, `edit()`, `compact()`,
  `ifBusy: 'queue' | 'steer'` and `inject()` with `deliver: 'next-step'` / `wake`.

- [`5aaf85c`](https://github.com/viandwi24/eharness/commit/5aaf85c3fcef2e0a1aaac765b951ead812f1e638) Thanks [@viandwi24](https://github.com/viandwi24)! - Skills: `defineSkill` and `defineSkillSource` with validation, static skills served through an
  in-memory source, skill-relative addressing with `validateSkillPath`, and `parseSkillMarkdown`
  (a dependency-free YAML subset for `SKILL.md` frontmatter, including `|`/`>` block scalars). The
  per-turn skill registry lists sources in plugin order with `refresh` caching, static skills winning
  over dynamic ones and first-wins shadowing between sources (`W_SHADOWED`), invalid
  metadata skipped (`W_INVALID_SKILL`) and failed listings retried next turn (new warning
  `W_SKILL_SOURCE_FAILED`). The model sees a sorted skills index in the system prompt (static skills
  in block 1, dynamic ones in block 2) or, above `skillsIndexLimit`, a search hint. The skill tools
  are stable for the whole session (`load_skill`/`read_skill_file` whenever a skill source exists,
  `search_skills` when search mode is reachable); they return errors as `ERROR:` strings and never
  pass an invalid path to a source. The `skill.load` hook event now carries `location` from
  `SkillSource.locate()`, and plugins can emit warnings with the new `ctx.warn()`.
  `eharness/testing` adds `skillSourceConformance` and `SKILL_SOURCE_FIXTURE`.

- [`0b6cc9c`](https://github.com/viandwi24/eharness/commit/0b6cc9c958e045038b5518efe15959f63b54487e) Thanks [@viandwi24](https://github.com/viandwi24)! - Tool sources and MCP: `defineToolSource({ defer: true })` marks a source's tools deferred and the
  core adds AI SDK's `toolSearch()` as `tool_search` whenever a deferred tool exists (discovered tools
  stay callable for the rest of the turn and after reloads); `defineToolSource` validates `refresh`,
  `defer`, `open` and `close`. Tool output limits (`toolOutput: { maxChars, perTool, strategy }`,
  default 50,000 characters): final outputs are truncated head + tail around
  `TOOL_OUTPUT_TRUNCATED` (structured outputs become `{ truncated, preview, originalChars }`), or
  evicted to the filesystem plugin's `toolOutputs` service with a `read_file` hint, with
  `W_TOOL_OUTPUT_LIMITED`. New `eharness/mcp` entry: `mcpServer()` turns an MCP server into a tool
  source over the optional peer `@ai-sdk/mcp` (loaded lazily) with one client per session, lazy or
  eager connect, allow/deny, prefixing, `defer: 'auto'`, `maxRetries`, reconnects after failures
  (`W_TOOL_SOURCE_FAILED`), definition pinning with drift exclusion (`W_MCP_DRIFT`) and
  `clearMcpPins()`.
  `eharness/mcp` no longer exports the `experimental_placeholder` constant (it was a placeholder with
  no behaviour). `read_file` now keeps its continuation hint inside `maxReadChars`, so a full window
  fits the default tool output limit.
  A failed session open now aborts the session's `ctx.signal` before that attempt's disposers run
  (a retried open gets a fresh signal), so plugins and tool sources release per-session resources.

## 0.0.2

### Patch Changes

- [#1](https://github.com/viandwi24/eharness/pull/1) [`55c3525`](https://github.com/viandwi24/eharness/commit/55c3525a546bd5c2e1d39be3fa802fd80f45c9ce) Thanks [@viandwi24](https://github.com/viandwi24)! - update docs
