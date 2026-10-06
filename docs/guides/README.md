# Guides

Task-oriented walkthroughs. The contracts behind them are in [`../specs`](../specs); runnable code
is in [`../../examples`](../../examples) (every example runs offline with `bun examples/<file>`).

| Guide | You will learn |
|---|---|
| [Getting started](getting-started.md) | install, a first agent, run it on Node or Bun, offline testing |
| [Instructions, tools and MCP](tools-and-mcp.md) | static and dynamic instructions/tools, tool sources, tool search, `mcpServer`, output limits, timeouts, per-turn models |
| [Writing a plugin](writing-a-plugin.md) | `definePlugin`: tools, services, hooks, state, data parts |
| [Writing a storage adapter](writing-a-storage-adapter.md) | `MessageAdapter`, `StateAdapter`, `SessionLock`, `InboxAdapter`, conformance tests |
| [Running several instances](multi-instance.md) | lock, `setIf`, `lastId`, the durable inbox (queue, steer, wake, collect, abort across instances), sweeper |
| [Production patterns](production-patterns.md) | ephemeral context, episodic memory, background events, heartbeats ("silent OK"), skills from a database, and the security checklist |
| [Rendering data parts](rendering-data-parts.md) | custom UI data: persistent vs transient, kinds, typed rendering |
| [Skills](skills.md) | static skills, `SKILL.md` folders, custom skill sources |
| [Filesystem](filesystem.md) | the `filesystem()` plugin: file tools, safety rules, services, custom adapters |
| [Context and compaction](compaction.md) | summarization, markers, context stats, the guard, overflow recovery |
| [Approvals and interaction](approvals-and-interaction.md) | tool approval by policy or risk, audit hook, approval inbox, client tools, regenerate/edit, steer, queue, wake |
| [Frontend tools and page context](client-tools.md) | request-declared client tools and page context: opt-in, validation, approval, timeouts, the cache cost |
| [External waits](external-waits.md) | `externalTool()`: park a turn on a webhook / job / person, `resolveWait()` from any instance, timeouts, `expireWaits()` |
| [Structured output](structured-output.md) | typed final answers: `output: { schema }`, tool vs native mode, retries, `'output-invalid'`, storage |
| [Long-running turns](long-running-turns.md) | step budget, wrap-up, progress guard (`'stuck'`), continuations, stop reasons |
| [Models and cost](models-and-cost.md) | model catalog, models.dev, `costUsd`, nested usage, USD budgets |
| [Todos](todos.md) | the `todos()` plugin: checklist tool, rendering, reminders, enforcement |
| [Memory](memory.md) | the `memory()` plugin: per-user memory files, read-only roots, pinned files, audit, provider memory tools |
| [OpenAPI tools](openapi-tools.md) | `openApiTools()`: curate operations, base URL and auth, risk and approval, limits |
| [Group chat](group-chat.md) | `groupChat()`: answer only when addressed, history of missed messages, bot-to-bot loop limit |
| [Subagents](subagents.md) | a tool that runs a child session with live progress, usage and cost |
| [Testing](testing.md) | `scriptedModel`, asserting on prompts and results, conformance suites |
| [Reference](reference.md) | every option, method, stop reason, error and warning at a glance |
