# eharness documentation

Reading order for a new contributor (human or agent):

1. [`concept.md`](concept.md) — what eharness is, what it is not, principles, glossary.
2. [`architecture.md`](architecture.md) — layers, module map, lifecycles, data flow.
3. [`specs/`](specs/) — the contracts. Read the ones for the module you touch.
4. [`decisions/`](decisions/) — ADRs: why the contracts look the way they do.
5. [`engineering/`](engineering/) — conventions, testing, API stability, release process.
6. [`plans/`](plans/) — the build board and phase files.

7. [`reference/prior-art.md`](reference/prior-art.md) — lessons from the predecessor harness and
   from other frameworks.

Using eharness (not contributing)? Start with the [README](../README.md), the [guides](guides/)
(for production: [production patterns](guides/production-patterns.md)) and the runnable
[examples](../examples); the [changelog](../CHANGELOG.md) has migration notes. Release handoffs
for external requesters live in [`reviews/`](reviews/) (0.4.0: [results](reviews/0.4.0-results.md)).

## Specs index

| # | Spec | Covers |
|---|---|---|
| 01 | [agent-and-plugins](specs/01-agent-and-plugins.md) | `defineHarnessAgent`, `definePlugin`, phases, hooks, services, context object, boot validation |
| 02 | [context-registry](specs/02-context-registry.md) | Static vs dynamic instructions/tools/skills/MCP, refresh timing, collisions, prompt-cache rules |
| 03 | [messages](specs/03-messages.md) | Message model, metadata, data parts, message kinds, model projection, validation, ids |
| 04 | [streaming](specs/04-streaming.md) | UI message stream protocol, writer, namespacing, transient vs persistent, attach/resume |
| 05 | [session-and-storage](specs/05-session-and-storage.md) | Session API, turn lifecycle, stop rules, wrap-up, progress guard, `MessageAdapter`, `StateAdapter`, loading, caching, locking, crash recovery, cross-process abort, durable inbox (`InboxAdapter`) |
| 06 | [compaction](specs/06-compaction.md) | The fixed compaction algorithm, config, triggers, prune stage, pre-compaction flush, thrash stop, guard, overflow recovery |
| 07 | [skills](specs/07-skills.md) | `Skill`, `SkillSource`, three-level loading, addressing, versions, filesystem autoload |
| 08 | [filesystem-plugin](specs/08-filesystem-plugin.md) | `FileSystem` contract (incl. optional `move`), file tools, staleness, `memoryFs` |
| 09 | [tools-and-mcp](specs/09-tools-and-mcp.md) | `ToolSource`, deferred tools, tool search, output limits, timeouts, client tools, `mcpServer` |
| 10 | [errors-and-stop-reasons](specs/10-errors-and-stop-reasons.md) | Error codes, stop reasons, warning codes |
| 11 | [interaction](specs/11-interaction.md) | Approvals (policy, risk, `approval.decided`), client tools, `respond`, regenerate/edit/rewind, steering, queue, wake, `handleChatRequest` |
| 12 | [models-and-cost](specs/12-models-and-cost.md) | Model catalog (`models`, `modelsDevCatalog`, `lookupModel`), pricing, `computeCost`, `costUsd`, USD budgets |
| 13 | [todos-plugin](specs/13-todos-plugin.md) | `eharness/todos`: `todo_write`, `data-todos.list`, reminders, enforcement |
| 14 | [memory-plugin](specs/14-memory-plugin.md) | `eharness/memory`: memory commands/tools, roots, pinned reminders, `onWrite`, app-supplied tool, `flushOnCompaction` |

## Status vocabulary

Specs carry a status line:

- **Draft** — may change freely.
- **Accepted** — implementation follows it; changes need a PR that updates spec + code together.
- **Frozen** — public since a release; changes follow `engineering/api-stability.md`.

Specs 01–11 are **Accepted (reviewed for 0.1.0)** and have been updated with every release since;
specs 12–13 are **Draft (0.3)** — shipped in 0.3.0 — and spec 14 is **Draft (0.4)**, all still
open to changes under the 0.x rules.
All become **Frozen** at 1.0 ([api-stability](engineering/api-stability.md)); until then changes
follow the 0.x rules there. Nothing in the public API is `experimental_`.
