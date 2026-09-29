# eharness documentation

Reading order for a new contributor (human or agent):

1. [`concept.md`](concept.md) — what eharness is, what it is not, principles, glossary.
2. [`architecture.md`](architecture.md) — layers, module map, lifecycles, data flow.
3. [`specs/`](specs/) — the contracts. Read the ones for the module you touch.
4. [`decisions/`](decisions/) — ADRs: why the contracts look the way they do.
5. [`engineering/`](engineering/) — conventions, testing, API stability, release process.
6. [`plans/`](plans/) — the build board and phase files.

Using eharness (not contributing)? Start with the [guides](guides/) and the runnable
[examples](../examples).
7. [`reference/prior-art.md`](reference/prior-art.md) — lessons from the predecessor harness and
   from other frameworks.

## Specs index

| # | Spec | Covers |
|---|---|---|
| 01 | [agent-and-plugins](specs/01-agent-and-plugins.md) | `defineHarnessAgent`, `definePlugin`, phases, hooks, services, context object, boot validation |
| 02 | [context-registry](specs/02-context-registry.md) | Static vs dynamic instructions/tools/skills/MCP, refresh timing, collisions, prompt-cache rules |
| 03 | [messages](specs/03-messages.md) | Message model, metadata, data parts, message kinds, model projection, validation, ids |
| 04 | [streaming](specs/04-streaming.md) | UI message stream protocol, writer, namespacing, transient vs persistent, attach/resume |
| 05 | [session-and-storage](specs/05-session-and-storage.md) | Session API, turn lifecycle, stop rules, `MessageAdapter`, `StateAdapter`, loading, caching, locking, crash recovery |
| 06 | [compaction](specs/06-compaction.md) | The fixed compaction algorithm, config, triggers, guard, overflow recovery |
| 07 | [skills](specs/07-skills.md) | `Skill`, `SkillSource`, three-level loading, addressing, filesystem autoload |
| 08 | [filesystem-plugin](specs/08-filesystem-plugin.md) | `FileSystem` contract, file tools, staleness, `memoryFs` |
| 09 | [tools-and-mcp](specs/09-tools-and-mcp.md) | `ToolSource`, deferred tools, tool search, output limits, timeouts, client tools, `mcpServer` |
| 10 | [errors-and-stop-reasons](specs/10-errors-and-stop-reasons.md) | Error codes, stop reasons, warning codes |
| 11 | [interaction](specs/11-interaction.md) | Approvals, client tools, `respond`, regenerate/edit/rewind, steering, queue, wake, `handleChatRequest` |

## Status vocabulary

Specs carry a status line:

- **Draft** — may change freely.
- **Accepted** — implementation follows it; changes need a PR that updates spec + code together.
- **Frozen** — public since a release; changes follow `engineering/api-stability.md`.

All specs are **Accepted (reviewed for 0.1.0)**. They become **Frozen** at 1.0
([api-stability](engineering/api-stability.md)); until then changes follow the 0.x rules there.
Nothing in the public API is `experimental_` in 0.1.0.
