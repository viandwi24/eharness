---
"eharness": minor
---

**eharness 0.1.0 — first public release.** Build your own agent harness on AI SDK v7:

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
