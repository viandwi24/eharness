# Guides

Task-oriented walkthroughs. The contracts behind them are in [`../specs`](../specs); runnable code
is in [`../../examples`](../../examples) (every example runs offline with `bun examples/<file>`).
New here? Read [getting started](getting-started.md); unfamiliar terms are in the
[glossary](../concept.md#glossary).

## Start here

| Guide | You will learn |
|---|---|
| [Which module do I need?](start-here.md) | the 33 entry points in three groups, when you need each, its stability label (stable, experimental, deprecated) and a 20-line example |
| [Getting started](getting-started.md) | install, a first agent, run it on Node or Bun, offline testing, tools that use the running chat, serving `useChat`, a tour of cost, approvals, waits, memory and several instances, defaults |
| [Upgrading to 0.7 and 0.8](upgrading.md) | 0.7 to 0.8 (renames, removed exports, breaking changes by area, behaviour changes) and 0.6 to 0.7, with migration snippets and known gaps |
| [Reference](reference.md) | every option, method, stop reason, error and warning at a glance |

## Build an agent

| Guide | You will learn |
|---|---|
| [Instructions, tools and MCP](tools-and-mcp.md) | static and dynamic instructions/tools, tool sources, tool search, `mcpServerSource`, output limits, timeouts, per-turn models |
| [Skills](skills.md) | static skills, `SKILL.md` folders, custom skill sources |
| [Filesystem](filesystem.md) | the `filesystem()` plugin: file tools, safety rules, services, custom adapters |
| [Writing a plugin](writing-a-plugin.md) | `definePlugin`: tools, services, hooks, state, data parts |
| [Structured output](structured-output.md) | typed final answers: `output: { schema }`, tool vs native mode, retries, `'output-invalid'`, storage |
| [Rendering data parts](rendering-data-parts.md) | custom UI data: persistent vs transient, kinds, typed rendering |
| [Evals](evals.md) | scoring an agent against a fixed scenario: deterministic checks, rubric judge, budget cap, comparing runs |
| [Testing](testing.md) | `scriptedModel`, asserting on prompts and results, conformance suites |

## Sessions, storage and scale

| Guide | You will learn |
|---|---|
| [Writing a storage adapter](writing-a-storage-adapter.md) | `MessageAdapter`, `StateAdapter`, `SessionLock`, `InboxAdapter`, conformance tests |
| [Running several instances](multi-instance.md) | lock, `setIf`, `lastId`, the durable inbox (queue, steer, wake, collect, abort across instances), poison items and dead-letter, sweeper |
| [Long-running turns](long-running-turns.md) | step budget, wrap-up, progress guard (`'stuck'`), continuations, stop reasons |
| [Context and compaction](compaction.md) | summarization, markers, context stats, the guard, overflow recovery |
| [External waits](external-waits.md) | `externalTool()`: park a turn on a webhook / job / person, `resolveWait()` from any instance, timeouts, `expireWaits()` |
| [Models and cost](models-and-cost.md) | model catalog, models.dev, `costUsd`, nested usage, USD budgets, [budgets across sessions](models-and-cost.md#budgets-across-sessions) (`budget.ledger`) |

## Interaction and safety

| Guide | You will learn |
|---|---|
| [Approvals and interaction](approvals-and-interaction.md) | tool approval by policy or risk, audit hook, approval inbox, client tools, regenerate/edit, steer, queue, wake |
| [Permissions](permissions.md) | `eharness/permissions`: rules, modes, plan mode, shell analysis, protected paths; autonomous, CLI and web/server setups |
| [Approval guard](guard.md) | `guard()`: an LLM judge that can only tighten, the restricted transcript, cache, circuit breaker, cost |
| [LLM judge: two modes](llm-judge.md) | the approval guard (`tighten`) vs permissions auto mode (`decide`): one shared engine, when to use which, combining them |
| [Frontend tools and page context](client-tools.md) | request-declared client tools and page context: opt-in, validation, approval, timeouts, the cache cost |
| [Ask the user](ask.md) | `ask()`: multiple-choice questions, answering through the pending state, non-interactive fallback |
| [Web fetch and search](web.md) | `webFetch()` safety rules and `webSearch()` provider recipes |
| [Shell](shell.md) | the `shell()` plugin: `bash` with live output, background tasks and wake-ups, the local sandbox and OS isolation, profiles (server, CLI, web) |

## Plugins

| Guide | You will learn |
|---|---|
| [Todos](todos.md) | the `todos()` plugin: checklist tool, rendering, reminders, enforcement |
| [Memory](memory.md) | the `memory()` plugin: per-user memory files, read-only roots, pinned files, audit, provider memory tools |
| [OpenAPI tools](openapi-tools.md) | `openApiSource()`: curate operations, base URL and auth, risk and approval, limits |
| [Group chat](group-chat.md) | `group()`: answer only when addressed, history of missed messages, bot-to-bot loop limit |
| [Subagents](subagents.md) | the `subagent()` plugin: child sessions, approvals inline / parked / by policy, background children, the manual pattern |
| [Chunked work](chunked-work.md) | process thousands of items without filling the context: collector and ingest, code pre-filter, manifest and resume, findings per chunk, reduce, report |
| [Code sandbox](code-sandbox.md) | `eharness/code`: `run_python` over the virtual file system, incremental sync and compare-and-set write-back, drivers and isolation, packages, disposable sandboxes, connector, `sync: false` |
| [Browser agents](browser-agents.md) | `eharness/browser`: an agent that opens pages, reads snapshots with refs, acts and sees screenshots; Chrome and Lightpanda, manual (CDP URL, container, hosted services) and managed modes, profiles and logins, live view and take-over, security, resources, troubleshooting |
| [Scheduler](scheduler.md) | `eharness/scheduler`: interval, one-off and cron schedules (croner as the parser) that fire into sessions across instances, idempotent fire ids, catch-up and overlap |
| [Lead and role agents](lead-and-role-agents.md) | a lead that hands work to role agents: roster from definitions, delegation briefs, park vs inline, follow-ups, limits, budgets, cost, when not to use it |

## Products: providers, connectors, HTTP and browser

| Guide | You will learn |
|---|---|
| [Providers and profiles](providers-and-profiles.md) | `eharness/providers`: several providers and saved profiles, dynamic model lists, prices into the agent, a settings form, secrets, encrypted stores |
| [Connectors](connectors.md) | `eharness/connectors`: connect tools per workspace or agent, setup flows and OAuth, per-agent enablement and modes, built-in connectors, rendering flows in a UI |
| [HTTP server](http-server.md) | `createHarnessHttp`: mount the chat, session, attention and activity routes on Hono, `Bun.serve` or Node; `authorize`; CORS headers |
| [Web client](web-client.md) | `eharness/client`: typed client, chat transport and session for Svelte and React, activity feed with restart detection, attention list |

## Operate and ship

| Guide | You will learn |
|---|---|
| [Observability](observability.md) | `observe`: phase durations and counters, an OpenTelemetry / Prometheus bridge, warning dedupe window |
| [Debugging and activity logs](debugging-and-activity-logs.md) | the `model.call` hook: a log of every LLM call with raw request/response, tokens, cost, latency; retention |
| [Production patterns](production-patterns.md) | ephemeral context, episodic memory, background events, several instances, poison items, long waits and webhooks, cross-session budgets, guard in production, group bots, heartbeats ("silent OK"), skills from a database, and the security checklist |
| [Production checklist](production-checklist.md) | one page to review before shipping: correctness, restarts and instances, streaming, security, cost, observability |

## Walkthroughs and example apps

| Guide | You will learn |
|---|---|
| [Walkthrough: multi-user server](walkthrough-server.md) | `examples/team` read in the order you would build it: storage, lock, stream log, inbox, recovery, background children, approvals, activity feed, `eharness/http`, `eharness/client`; why each exists and what breaks without it |
| [Walkthrough: single-process CLI](walkthrough-cli.md) | `examples/coder` the same way: workspace, shell, interactive permissions, compaction, todos, subagents, skills, MCP, resume and crash recovery, Ink |
| [A coding agent on eharness](coding-agent.md) | the map of `examples/coder`: modules used, permissions, sandbox, limits, resume and compaction, the git workflow, how to extend it |
| [Coding agent example](../../examples/coder/README.md) | a terminal coding agent built only on the public API: virtual workspace, permission rules, subagents, Ink UI |
| [Team app example](../../examples/team/README.md) | a web + server team of agents: agents as data, lead and role agents, board and approvals, routines, several instances, SQLite adapters |

