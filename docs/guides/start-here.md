# Start here: which module do I need?

eharness ships one package with **33 entry points** (`eharness` and 32 subpaths). You do not need
most of them. This page groups them in three groups, says when you need each, and gives the
stability label to expect. The labels are the same as in each module's entry doc comment (the
JSDoc at the top of its `index.ts`) and in [API stability](../engineering/api-stability.md):

| Label | Meaning | Changes |
|---|---|---|
| **stable** | Accepted spec; public API. | Breaking changes only by ADR and a minor bump in 0.x, a major after 1.0. |
| **experimental** | Draft spec; every symbol is `@experimental`. | May change in any minor release in 0.x (never in a patch), with a changeset that says so. |
| **deprecated** | `@deprecated` on every export, ADR-0062. | Kept until 1.0, removed then unless a product adopts it. |

These three groups are a reading aid, coarser than the four rings of
[ADR-0062](../decisions/0062-platform-rings-and-rule-of-two.md) (the core heads to 1.0; official
modules grow with real use). Nothing here is
installed separately; unused subpaths cost nothing.

## Core (every agent)

| Import | You need it when | Stability |
|---|---|---|
| `eharness` | always: `defineHarnessAgent`, sessions, plugins, messages, compaction, approvals, stream. The model catalog and cost, `createJudge`, `observe`, stream resume and a few options are Draft inside it (marked `@experimental`). | stable |
| `eharness/filesystem` | the model should read and write files (`read_file`, `edit_file`, ...), or you load skills from files. | stable |
| `eharness/filesystem/memory` | tests, prototypes, an agent whose files do not need to survive a restart. | stable |
| `eharness/filesystem/node` | the agent works on real directories (Node-only, ADR-0036). | stable |
| `eharness/storage/memory` | tests and single-process apps; production writes its own adapter ([storage adapter guide](writing-a-storage-adapter.md)). | stable |
| `eharness/mcp` | tools from MCP servers (optional peer `@ai-sdk/mcp`). | stable |
| `eharness/testing` | scripted models, conformance suites for your adapters. | stable |

## Common modules (most real harnesses)

| Import | You need it when | Stability |
|---|---|---|
| `eharness/permissions` | rule-based tool permissions (`Bash(git *)`), modes, plan mode, the `auto` classifier. | experimental |
| `eharness/subagent` | the model delegates work to child sessions (`agent` tool), including background children. | experimental |
| `eharness/todos` | a visible checklist the model keeps (`todo_write`) and "keep going while todos are open". | experimental |
| `eharness/memory` | file-based long-term memory with pinned files in the reminder. | experimental |
| `eharness/ask` | the model asks the user a multiple-choice question (works headless too). | experimental |
| `eharness/web` | `web_fetch` (SSRF guards) and `web_search`. | experimental |
| `eharness/web/node` | a DNS resolver for `webFetch` private-address checks (Node-only). | experimental |
| `eharness/shell` | `bash` with background tasks and an OS sandbox (Node-only). | experimental |
| `eharness/providers` | users pick providers and models at runtime: profiles, secret vault, model catalogs. | experimental |
| `eharness/http` | serve an agent as a `fetch`-style endpoint: chat with resume, session reads, attention, activity. | experimental |
| `eharness/client` | the browser side of `eharness/http`: typed client, chat session, activity feed (runtime imports only `ai`). | experimental |
| `eharness/client/react` | React bindings by injection (no React peer dependency). | experimental |

## Advanced and product modules (reach for them on purpose)

| Import | You need it when | Stability |
|---|---|---|
| `eharness/activity` | an audit/event feed of session activity and an attention queue (pending approvals, questions) across sessions. | experimental |
| `eharness/connectors` | a connectors screen: definitions, connections, per-agent enablement, setup flows, OAuth. | experimental |
| `eharness/scheduler` | schedules (cron, interval, one-shot) that fire into sessions across instances. | experimental |
| `eharness/identity` | one person with many platform accounts, pairing codes, roles by risk. | experimental |
| `eharness/channels` | delivery to chat platforms: rate governor, outbox with retries, mention safety. | experimental |
| `eharness/handoff` | the agent asks a person and the turn parks until any instance records the answer. | experimental |
| `eharness/limits` | step budgets, readable budget stops, long jobs as chained bounded turns. | experimental |
| `eharness/clock` | the model needs the current time or time-zone arithmetic (`datetime`). | experimental |
| `eharness/code` | the model runs Python over the virtual file system. | experimental |
| `eharness/browser` | the agent drives a real browser (snapshots, refs, screenshots, live view). | experimental |
| `eharness/browser/node` | managed Chrome / Lightpanda runtimes for `eharness/browser` (Node-only). | experimental |
| `eharness/group` | multi-party chat gating. Migration: [group chat](group-chat.md#deprecated-removed-in-10). | deprecated |
| `eharness/guard` | LLM approval judge. Use the `auto` mode of `eharness/permissions`: [guard](guard.md#deprecated-removed-in-10). | deprecated |
| `eharness/openapi` | OpenAPI operations as tools. Use your own tools or MCP: [OpenAPI tools](openapi-tools.md#deprecated-removed-in-10). | deprecated |

Runtime-neutral by default (Node >= 22 and Bun); the Node-only entry points are
`filesystem/node`, `shell`, `browser/node` and `web/node`.

## A minimal example

An offline agent with a file tool and a checklist, using a scripted model (swap `model` for an AI
Gateway string or any AI SDK model to run it for real):

```ts
import { defineHarnessAgent } from 'eharness'
import { filesystem } from 'eharness/filesystem'
import { inMemoryFs } from 'eharness/filesystem/memory'
import { scriptedModel } from 'eharness/testing'
import { todos } from 'eharness/todos'

const model = scriptedModel([
  { toolCalls: [{ toolName: 'write_file', input: { path: '/notes/a.md', content: 'hi\n' } }] },
  { text: 'Saved /notes/a.md.' },
])

const agent = defineHarnessAgent({
  model, // or 'anthropic/claude-sonnet-4.6' (AI Gateway) / any AI SDK model
  contextWindow: 200_000,
  instructions: 'Keep notes as files under /notes.',
  plugins: [filesystem({ fs: inMemoryFs() }), todos()],
})

const run = agent.session('demo').send('Write a note')
const result = await run.result // never rejects: errors end the turn with stop: 'error'
console.log(result.stop, result.steps) // 'complete' 2
await agent.close()
```

Next: [getting started](getting-started.md) for the full tour, the [guide index](README.md), and
[upgrading](upgrading.md) when you move between versions.
