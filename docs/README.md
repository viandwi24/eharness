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
[examples](../examples); the [changelog](../CHANGELOG.md) has migration notes.

## Specs index

| # | Spec | Covers |
|---|---|---|
| 01 | [agent-and-plugins](specs/01-agent-and-plugins.md) | `defineHarnessAgent`, `definePlugin`, phases, hooks, services, context object, boot validation |
| 02 | [context-registry](specs/02-context-registry.md) | Static vs dynamic instructions/tools/skills/MCP, refresh timing, collisions, prompt-cache rules |
| 03 | [messages](specs/03-messages.md) | Message model, metadata, data parts, message kinds, model projection, validation, ids |
| 04 | [streaming](specs/04-streaming.md) | UI message stream protocol, writer, namespacing, transient vs persistent, attach/resume |
| 05 | [session-and-storage](specs/05-session-and-storage.md) | Session API, turn lifecycle, stop rules, wrap-up, progress guard, `MessageAdapter`, `StateAdapter`, loading, caching, locking, crash recovery, cross-process abort, durable inbox (`InboxAdapter`: retries, dead-letter, `availableAt` timers) |
| 06 | [compaction](specs/06-compaction.md) | The fixed compaction algorithm, config, triggers, prune stage, pre-compaction flush, thrash stop, guard, overflow recovery |
| 07 | [skills](specs/07-skills.md) | `Skill`, `SkillSource`, three-level loading, addressing, versions, filesystem autoload |
| 08 | [filesystem-plugin](specs/08-filesystem-plugin.md) | `FileSystem` contract (incl. optional `move`), file tools, staleness, `memoryFs` |
| 09 | [tools-and-mcp](specs/09-tools-and-mcp.md) | `ToolSource`, deferred tools, tool search, output limits, timeouts, client tools, `mcpServer` |
| 10 | [errors-and-stop-reasons](specs/10-errors-and-stop-reasons.md) | Error codes, stop reasons, warning codes |
| 11 | [interaction](specs/11-interaction.md) | Approvals (policy, risk incl. `'external'`, `approval.decided`), client tools, external waits (`resolveWait`), request-scoped client tools and page context, `respond`, regenerate/edit/rewind, steering, queue, wake, `handleChatRequest` |
| 12 | [models-and-cost](specs/12-models-and-cost.md) | Model catalog (`models`, `modelsDevCatalog`, `lookupModel`), pricing, `computeCost`, `costUsd`, USD budgets, the cross-session `BudgetLedger` |
| 13 | [todos-plugin](specs/13-todos-plugin.md) | `eharness/todos`: `todo_write`, `data-todos.list`, reminders, enforcement |
| 14 | [memory-plugin](specs/14-memory-plugin.md) | `eharness/memory`: memory commands/tools, roots, pinned reminders, `onWrite`, app-supplied tool, `flushOnCompaction` |
| 15 | [guard-plugin](specs/15-guard-plugin.md) | `eharness/guard`: LLM approval judge — tighten-only, restricted transcript, fast path, verdict cache, circuit breaker, fail closed |
| 16 | [group-plugin](specs/16-group-plugin.md) | `eharness/group`: should-respond gating, pending history of gated-out messages, speaker metadata, bot-to-bot anti-loop |
| 17 | [openapi-plugin](specs/17-openapi-plugin.md) | `eharness/openapi`: OpenAPI 3.x → tools — filters, base-URL fence, app-supplied auth, risk from method, `$ref` guard, error strings |
| 18 | [permissions-plugin](specs/18-permissions-plugin.md) | `eharness/permissions`: `Tool(spec)` rules, modes (incl. Draft `auto` mode and classifier), shell command analysis, protected paths, plan mode, output filtering |
| 19 | [shell-plugin](specs/19-shell-plugin.md) | `eharness/shell` (Node-only): `bash`, live output, background tasks (`bash_output`, `kill_shell`), `shellTasks`, local sandbox with OS isolation |
| 20 | [subagent-plugin](specs/20-subagent-plugin.md) | `eharness/subagent`: the `agent` tool, child sessions, approvals inline / park / policy, background agents, `agent_output`, `agent_stop`, Draft agent messaging (`send_message`, names, resume) |
| 21 | [ask-plugin](specs/21-ask-plugin.md) | `eharness/ask`: `ask_user_question`, client tool or non-interactive fallback |
| 22 | [web-plugin](specs/22-web-plugin.md) | `eharness/web`: `web_fetch` (SSRF guards, Markdown, framing) and `web_search` (provider-agnostic) |

## Status vocabulary

Specs carry a status line:

- **Draft** — may change freely.
- **Accepted** — implementation follows it; changes need a PR that updates spec + code together.
- **Frozen** — public since a release; changes follow `engineering/api-stability.md`.

Specs 01–11 are **Accepted (reviewed for 0.1.0)** and have been updated with every release since;
specs 12–13 are **Draft (0.3)** — shipped in 0.3.0 —, spec 14 is **Draft (0.4)**, specs 15–17
are **Draft (0.5)** and specs 18–22 are **Draft (0.7)**, all still open to changes under the 0.x
rules. Individual sections of an Accepted spec can be marked **Draft** (0.7: spec 02 §3.3 deferred
tools reminder, spec 03 §10 `<untrusted-content>` frame, spec 08 §13 project instructions); the
list and the rule are in [api-stability](engineering/api-stability.md#draft-modules-and-sections).
All become **Frozen** at 1.0 ([api-stability](engineering/api-stability.md)); until then changes
follow the 0.x rules there. Nothing in the public API is `experimental_`; Draft sections are marked `@experimental` in TSDoc instead.
