# eharness documentation

Reading order for a new contributor (human or agent):

1. [`concept.md`](concept.md): what eharness is, what it is not, principles, glossary.
2. [`architecture.md`](architecture.md): layers, source map, import rules, export table,
   lifecycles, data flow.
3. [`specs/`](specs/): the contracts. Read the ones for the module you touch.
4. [`decisions/`](decisions/): ADRs, why the contracts look the way they do.
5. [`engineering/`](engineering/): conventions, testing, API stability, release process.
6. [`plans/`](plans/): the build board and phase files.
7. [`reference/prior-art.md`](reference/prior-art.md): lessons from the predecessor harness and
   from other frameworks.

Using eharness (not contributing)? Start with the [README](../README.md), then the
[guides](guides/README.md) (index of every guide), beginning with
[getting started](guides/getting-started.md); for production read
[production patterns](guides/production-patterns.md) and the
[production checklist](guides/production-checklist.md). Runnable code is in
[examples](../examples). Moving between versions: [upgrading](guides/upgrading.md) and the
[changelog](../CHANGELOG.md). Unfamiliar term (turn, step, kind message, commit point, runtime)?
See the [glossary](concept.md#glossary).

Building a real harness? Read the two walkthroughs of the benchmark apps, in this order:
[multi-user server](guides/walkthrough-server.md) (`examples/team`) or
[single-process CLI](guides/walkthrough-cli.md) (`examples/coder`), then review your work against the
[production checklist](guides/production-checklist.md). They explain what each piece does, why it
is needed and what breaks without it, pointing at real code.

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
| 08 | [filesystem-plugin](specs/08-filesystem-plugin.md) | `FileSystem` contract (incl. optional `move`), file tools, staleness, `inMemoryFs` |
| 09 | [tools-and-mcp](specs/09-tools-and-mcp.md) | `ToolSource`, deferred tools, tool search, output limits, timeouts, client tools, `mcpServerSource` |
| 10 | [errors-and-stop-reasons](specs/10-errors-and-stop-reasons.md) | Error codes (one taxonomy in `src/codes.ts`), stop reasons, warning codes, observability (`observe`) |
| 11 | [interaction](specs/11-interaction.md) | Approvals (policy, risk incl. `'external'`, `approval.decided`), client tools, external waits (`resolveWait`), request-scoped client tools and page context, `respond`, regenerate/edit/rewind, steering, queue, wake, `handleChatRequest` |
| 12 | [models-and-cost](specs/12-models-and-cost.md) | Model catalog (`models`, `modelsDevCatalog`, `lookupModel`), pricing, `computeCost`, `costUsd`, USD budgets, the cross-session `BudgetLedger` |
| 13 | [todos-plugin](specs/13-todos-plugin.md) | `eharness/todos`: `todo_write`, `data-todos.list`, reminders, enforcement |
| 14 | [memory-plugin](specs/14-memory-plugin.md) | `eharness/memory`: memory commands/tools, roots, pinned reminders, `onWrite`, app-supplied tool, `flushOnCompaction` |
| 15 | [guard-plugin](specs/15-guard-plugin.md) | `eharness/guard`: LLM approval judge on the shared `createJudge` engine — tighten-only, restricted transcript, fast path, verdict cache, circuit breaker, fail closed |
| 16 | [group-plugin](specs/16-group-plugin.md) | `eharness/group`: should-respond gating, pending history of gated-out messages, speaker metadata, bot-to-bot anti-loop |
| 17 | [openapi-plugin](specs/17-openapi-plugin.md) | `eharness/openapi`: OpenAPI 3.x → tools — filters, base-URL fence, app-supplied auth, risk from method, `$ref` guard, error strings |
| 18 | [permissions-plugin](specs/18-permissions-plugin.md) | `eharness/permissions`: `Tool(spec)` rules, modes (incl. Draft `auto` mode and classifier), shell command analysis, protected paths, plan mode, output filtering |
| 19 | [shell-plugin](specs/19-shell-plugin.md) | `eharness/shell` (Node-only): `bash`, live output, background tasks (`bash_output`, `kill_shell`), `shellTasks`, local sandbox with OS isolation |
| 20 | [subagent-plugin](specs/20-subagent-plugin.md) | `eharness/subagent`: the `agent` tool, child sessions, approvals inline / park / policy, background agents, `agent_output`, `agent_stop`, Draft agent messaging (`send_message`, names, resume) |
| 21 | [ask-plugin](specs/21-ask-plugin.md) | `eharness/ask`: `ask_user_question`, client tool or non-interactive fallback |
| 22 | [web-plugin](specs/22-web-plugin.md) | `eharness/web`: `web_fetch` (SSRF guards, Markdown, framing) and `web_search` (provider-agnostic) |
| 23 | [providers](specs/23-providers.md) | `eharness/providers`: provider definitions, profiles and store, manager (`resolve`, models, `catalog()`), form spec, secret redaction, cached catalog loader |
| 24 | [connectors](specs/24-connectors.md) | `eharness/connectors`: connector definitions, connections and enablement, setup flow engine, OAuth helpers, activation into plugins, sources and permission rules, built-in connectors |
| 25 | [activity](specs/25-activity.md) | `eharness/activity`: `activity()` plugin, `ActivityStore` port, SSE helpers, attention queue (`listAttention`, `answerAttention`) |
| 26 | [http](specs/26-http.md) | `eharness/http`: `createHarnessHttp` (chat with resume, steering and interrupt, session reads, attention, activity), one `authorize` hook, wire types, `httpConformance` |
| 27 | [client](specs/27-client.md) | `eharness/client`: typed fetch client, chat transport, chat session (history, follow, steer, recovery), activity feed (SSE, restart detection), attention list, `Store<T>`; `eharness/client/react` |
| 28 | [code-plugin](specs/28-code-plugin.md) | `eharness/code` (Draft): `run_python` over the virtual file system (sync in/out, compare-and-set write-back), packages, `syncedSandbox()` |
| 29 | [scheduler](specs/29-scheduler.md) | `eharness/scheduler` (Draft): schedule store port, multi-instance scheduler, deterministic fire ids, injected cron parser |
| 30 | [identity](specs/30-identity.md) | `eharness/identity` (Draft): persons, platform accounts by stable id, pairing codes, `resolveRole`, `decideByRisk` |
| 31 | [channels](specs/31-channels.md) | `eharness/channels` (Draft): rate governor, outbox with retries, dead letter and circuit breaker, mention safety |
| 32 | [handoff](specs/32-handoff.md) | `eharness/handoff` (Draft): ask a person, park the turn, resolve from any instance |
| 33 | [limits](specs/33-limits.md) | `eharness/limits` (Draft): `stepBudget`, `budgetNotice` |
| 34 | [clock](specs/34-clock.md) | `eharness/clock` (Draft): datetime tool and time-zone arithmetic |
| 35 | [browser](specs/35-browser.md) | `eharness/browser` (Draft): browser adapters and registry, profiles, CDP connection (snapshot refs, act, screenshots, read), manager with leases, live view and takeover; `eharness/browser/node` runtimes |

## Status vocabulary

Specs carry a status line:

- **Draft** — may change freely.
- **Accepted** — implementation follows it; changes need a PR that updates spec + code together.
- **Frozen** — public since a release; changes follow `engineering/api-stability.md`.

Specs 01–11 are **Accepted (reviewed for 0.1.0)** and are updated with every release. Specs
12–27 are **Draft**, labelled with the release that made them public: spec 12 and 13 (0.3), 14
(0.4), 15–17 (0.5), 18–22 (0.7) and 23–27 (0.8); all stay open to changes under the 0.x rules.
Individual sections of an Accepted spec can be marked **Draft** (spec 02 §3.3 deferred tools
reminder, spec 03 §10 `<untrusted-content>` frame, spec 08 §13 project instructions); the list and
the rule are in [api-stability](engineering/api-stability.md#draft-modules-and-sections). All
become **Frozen** at 1.0 ([api-stability](engineering/api-stability.md)); until then changes follow
the 0.x rules there. Nothing in the public API is `experimental_`; Draft sections are marked
`@experimental` in TSDoc instead.
