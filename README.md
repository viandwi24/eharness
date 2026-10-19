# eharness

> Build your own agent harness on the [Vercel AI SDK](https://ai-sdk.dev) v7: plugins, context,
> messages, streaming, sessions and compaction, with storage you plug in.

[![CI](https://github.com/viandwi24/eharness/actions/workflows/ci.yml/badge.svg)](https://github.com/viandwi24/eharness/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/eharness)](https://www.npmjs.com/package/eharness)

Every agent built on AI SDK ends up writing the same harness around `streamText`: a step loop,
prompt assembly, skills, MCP, history that survives restarts, compaction, approvals, a UI stream.
**eharness** is that skeleton as a library. You keep your server, auth, database and domain logic;
it standardises the parts every harness reimplements and stays out of the rest.

**Status.** The contracts in [`docs/specs`](docs/specs) are implemented and tested. Before 1.0,
breaking changes ship only in minor versions with a migration note in the
[changelog](CHANGELOG.md) and in [Upgrading](docs/guides/upgrading.md)
([API stability](docs/engineering/api-stability.md)). Modules marked *Draft* below may change in a
minor release.

## Why

- **Plugins and typed context.** Tools, skills, instructions, hooks, services and UI data parts
  bundle into plugins. Declare them as constants or load them at runtime (per user, per turn, from
  a database, from MCP); the agent does not care which.
- **AI SDK all the way down.** The stream is the AI SDK UI message stream (it works with `useChat`
  as is), messages are `UIMessage`s, tools are `tool()`, models are `LanguageModel`. No parallel
  types.
- **Storage is yours.** A two-method `MessageAdapter`, a `StateAdapter`, an optional durable
  inbox. The library ships memory adapters and conformance suites, so your Postgres, JSON or Redis
  adapter is provably correct.
- **Built for long, interactive, multi-instance turns.** 500 steps by default with a progress
  guard, fixed compaction, USD budgets, risk-based approvals, steering, crash recovery, locks and a
  Stop button that reaches the instance running the turn.
- **Product building blocks, all optional.** Filesystem, shell, permissions, subagents, memory,
  todos, an LLM approval guard, OpenAPI tools, providers, connectors, an activity feed, an HTTP
  module and a browser client.

How it compares:

| | What it is | Relation to eharness |
|---|---|---|
| AI SDK core (`ai`) | Model calls, tools, streams, UI messages | eharness is built directly on it; no parallel types |
| AI SDK Harnesses (`@ai-sdk/harness`) | Adapter layer to run *existing* harness runtimes (Claude Code, Codex, ...) in a sandbox | Different layer: eharness is for building **your own** harness |
| eve (Vercel) | Filesystem-first, opinionated agent framework with Vercel-native durability | eharness is code-first, unopinionated about infrastructure and much thinner |
| Mastra | Full framework (workspaces, memory, workflows, deployment) | eharness is a library, not a framework: it owns no server, routes, auth or UI |
| LangChain Deep Agents | Harness on LangGraph with pluggable filesystem backends | Similar ideas (backends, composition); eharness has no graph runtime dependency |

More in [concept](docs/concept.md) (what eharness is and is not, principles, glossary).

## Install

```bash
npm install eharness ai zod     # or: bun add / pnpm add
npm install @ai-sdk/mcp         # only if you use eharness/mcp
```

Node ≥ 22 or Bun. ESM only. `ai` and `zod` are peer dependencies; eharness has no runtime
dependencies of its own.

## Quick start

```ts
import { tool } from 'ai'
import { defineHarnessAgent, defineSkill } from 'eharness'
import { filesystem } from 'eharness/filesystem'
import { inMemoryFs } from 'eharness/filesystem/memory'
import { z } from 'zod/v4'

const agent = defineHarnessAgent({
  model: 'anthropic/claude-sonnet-4.6', // AI Gateway id or any AI SDK model
  contextWindow: 200_000,
  instructions: 'You are a careful assistant. Keep notes as files under /notes.',
  tools: {
    get_time: tool({
      description: 'Current time as an ISO string',
      inputSchema: z.object({}),
      execute: async () => new Date().toISOString(),
    }),
  },
  skills: [
    defineSkill({
      name: 'note-style',
      description: 'Use before writing a note.',
      content: 'Bullets only.',
    }),
  ],
  plugins: [filesystem({ fs: inMemoryFs() })],
})

const session = agent.session('demo')
const run = session.send('Write the current time to /notes/now.md')
for await (const chunk of run.stream) {
  if (chunk.type === 'text-delta') process.stdout.write(chunk.delta) // or, in a route: await run.toResponse()
}

const result = await run.result // never rejects: errors end the turn with stop: 'error'
console.log(`\n${result.stop} after ${result.steps} steps`)
if (result.stop === 'error') console.error(result.error?.code, result.error?.message) // e.g. EH_PROVIDER_AUTH: set AI_GATEWAY_API_KEY
console.log(`${(await session.messages()).length} messages stored`)
```

The model string goes through the [AI Gateway](https://vercel.com/docs/ai-gateway)
(`AI_GATEWAY_API_KEY`); any AI SDK provider model (`anthropic('claude-sonnet-4-6')`, ...) works too.
This code is [`examples/quick-start.ts`](examples/quick-start.ts); `bun examples/quick-start.ts`
runs it offline with a scripted model. Walkthrough: [getting started](docs/guides/getting-started.md).
Terms such as *turn*, *step*, *kind message* and *commit point* are in the
[glossary](docs/concept.md#glossary).

## Tour

Each snippet is small; the guide linked under it has the full version. Values marked
`// yours: ...` are your application's.

### Serve it to `useChat`

```ts
import { handleChatRequest } from 'eharness'
import { agent } from './agent' // yours: the agent from the quick start

declare function authenticate(req: Request): Promise<{ id: string }> // yours
declare function userOwnsChat(userId: string, chatId: string): Promise<boolean> // yours

// POST /api/chat: send, approval answers, regenerate and edit in one route
export async function POST(req: Request): Promise<Response> {
  const user = await authenticate(req) // eharness knows only the session id
  const body = await req.json() // useChat's { id, messages, trigger, messageId }
  if (!(await userOwnsChat(user.id, body.id))) return new Response(null, { status: 404 })
  return await handleChatRequest(agent.session(body.id), body, {
    runtime: { userId: user.id }, // per-request values go into the turn, not the cached session
  }).toResponse() // waits until the turn is accepted, so a failure gets its HTTP status
}

// GET /api/chat/[id]/stream: useChat({ resume: true }) replays the running turn
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params
  const user = await authenticate(req)
  if (!(await userOwnsChat(user.id, id))) return new Response(null, { status: 404 }) // same check
  const run = agent.session(id).attach() // the running turn, or undefined when idle
  return run ? run.toStreamResponse() : new Response(null, { status: 204 })
}
```

On the client: `useChat<InferHarnessUIMessage<typeof agent>>()` types every data part, tool and
message kind. Runnable: [`examples/next-route.ts`](examples/next-route.ts) (offline demo:
`bun examples/next-route.demo.ts`). Guides: [HTTP server](docs/guides/http-server.md),
[getting started](docs/guides/getting-started.md#6-serve-it-to-usechat).

**Which one: `handleChatRequest` or `createHarnessHttp`?**

| You have | Use | You get |
|---|---|---|
| One chat route in your own framework (Next, Hono, Express, ...) | `handleChatRequest(...)` from `eharness` (and `handleResumeRequest(...)` to resume across instances with a stream log) | The `useChat` protocol on routes you write. Auth, ownership checks and every other route are yours. |
| A whole server, or a browser using `eharness/client` | `createHarnessHttp(agent, { authorize })` from `eharness/http` (Draft) | Chat, resume, steer, interrupt, session reads, attention queue and activity feed behind one `authorize` hook, with idempotency and status codes handled. A `fetch(Request)` handler. |
| A script, a test, a CLI | `session.send()`; read `run.stream` and `await run.result` | No HTTP. |

In a POST route use `await run.toResponse()`: a failure before the turn is accepted (busy, bad
input) answers 409 / 400 / 503. `run.toStreamResponse()` streams at once and carries such
failures inside a `200` stream; use it for resume only.

### Tools that know the chat

Write a tool as `(ctx) => tool()` to get the session, the turn, your runtime values and state, and
a typed writer for custom UI data parts:

```ts
import { tool } from 'ai'
import { defineDataPart, defineHarnessAgent } from 'eharness'
import { z } from 'zod/v4'

const agent = defineHarnessAgent({
  model: 'anthropic/claude-sonnet-4.6',
  dataParts: {
    invoice: defineDataPart({ schema: z.object({ total: z.number(), status: z.string() }) }),
  },
  tools: {
    create_invoice: (ctx) =>
      tool({
        description: 'Create and send an invoice',
        inputSchema: z.object({ total: z.number() }),
        execute: async ({ total }, { toolCallId }) => {
          ctx.state.set('lastInvoice', total) // persisted with the session
          ctx.stream.data('invoice', { total, status: 'sent' }, { id: toolCallId }) // typed
          return `Invoice sent for ${String(ctx.runtime.userId)}` // agent.session(id, { runtime })
        },
      }),
  },
})
```

Guides: [getting started](docs/guides/getting-started.md#5-tools-that-use-the-running-chat),
[rendering data parts](docs/guides/rendering-data-parts.md). Runnable:
[`examples/tool-context.ts`](examples/tool-context.ts).

### Risk-based approvals

Tools declare a risk; the agent decides which risks need a person. `respond()` records who
answered, and one hook sees every decision:

```ts
import { tool } from 'ai'
import { defineHarnessAgent } from 'eharness'
import { z } from 'zod/v4'

const agent = defineHarnessAgent({
  model: 'anthropic/claude-sonnet-4.6',
  tools: {
    delete_record: tool({
      inputSchema: z.object({ id: z.string() }),
      metadata: { risk: 'destructive' }, // 'read' | 'write' | 'destructive' | 'external'
      execute: async ({ id }) => `Deleted ${id}`,
    }),
  },
  approval: { risk: { destructive: 'user-approval', unknown: 'user-approval' } },
})

const session = agent.session('ops-1')
const { pending } = await session.send('Delete record r1').result // stop: 'tool-pending'
await session.respond({
  approvals: (pending?.approvals ?? []).map((p) => ({ id: p.approvalId, approved: true })),
}).result
```

With `useChat`, approvals need no server code: `handleChatRequest` calls `respond()`. Guides:
[approvals and interaction](docs/guides/approvals-and-interaction.md),
[permissions](docs/guides/permissions.md), [approval guard](docs/guides/guard.md).

### Long turns, cost and budgets

Turns run up to 500 steps. A progress guard stops a turn that repeats itself or keeps failing
(`stop: 'stuck'`), and when the step budget runs out the model gets one tool-less step to
summarize. With prices, every turn records its estimated cost and USD budgets are enforced:

```ts
import { defineHarnessAgent, modelsDevCatalog } from 'eharness'

declare const modelsDevJson: unknown // yours: models.dev's api.json, fetched and cached by your app

const agent = defineHarnessAgent({
  model: 'anthropic/claude-sonnet-4.6',
  models: modelsDevCatalog(modelsDevJson), // context window and prices (or your own record)
  budget: { maxTurnUsd: 2, maxSessionUsd: 20 }, // used up: stop 'cost-cap'
})

const result = await agent.session('job-1').send('Migrate the test suite').result
console.log(result.stop, result.usage.costUsd) // 'complete' | 'stuck' | 'max-steps' | 'cost-cap' | ...
```

Guides: [long-running turns](docs/guides/long-running-turns.md),
[models and cost](docs/guides/models-and-cost.md), [todos](docs/guides/todos.md).

### Storage and several instances

```ts
import { defineHarnessAgent } from 'eharness'
import type { InboxAdapter, MessageAdapter, StateAdapter } from 'eharness'

declare const messages: MessageAdapter // yours: Postgres, JSON files, ...
declare const state: StateAdapter // yours
declare const inbox: InboxAdapter // yours (optional): queue, steer, wake and abort across instances

const agent = defineHarnessAgent({
  model: 'anthropic/claude-sonnet-4.6',
  storage: { messages, state, inbox },
  recovery: { instanceId: 'web-1' }, // a stable id: a restarted process recovers its turns at once
})

const session = agent.session('chat-1')
await session.enqueue('One more thing...', { mode: 'collect' }) // any instance
await session.abort() // stops the turn even when another instance runs it
```

Guides: [writing a storage adapter](docs/guides/writing-a-storage-adapter.md),
[several instances](docs/guides/multi-instance.md),
[production patterns](docs/guides/production-patterns.md). More snippets (external waits, browser
tools, guard, ledger, memory, background events) are in
[getting started](docs/guides/getting-started.md#7-more-capabilities).

## Entry points

Every `package.json#exports` entry. *Draft* means all symbols of the subpath are experimental and
may change in a minor release ([API stability](docs/engineering/api-stability.md)). *Node-only*
subpaths import `node:` built-ins; everything else is runtime-neutral.

| Import | Status | Contents |
|---|---|---|
| `eharness` | Accepted (model catalog and cost: Draft) | `defineHarnessAgent`, `definePlugin`, `wrapPlugin`, `defineSkill`, `defineSkillSource`, `defineToolSource`, `defineDataPart`, `defineMessageKind`, `handleChatRequest`, `handleResumeRequest`, `externalTool`, `toolTraits`, `createJudge`, `modelsDevCatalog`, `openRouterCatalog`, `lookupModel`, `computeCost`, `observeModel`, `isPrivateHost`, errors, stored-text constants, types |
| `eharness/filesystem` | Accepted | `FileSystem` contract, `filesystem()` plugin (file tools, skills autoload), `fsSkillSource()`, checkpoints, `projectInstructions()` (Draft), helpers |
| `eharness/filesystem/memory` | Accepted | `inMemoryFs()` |
| `eharness/filesystem/node` | Accepted, Node-only | `diskFs()`, `mountFs()`, `nodeWorkspace()`, `nodeCheckpointStore()`, `nodeRealpath()` |
| `eharness/storage/memory` | Accepted | `inMemoryMessages()`, `inMemoryState()` (the default storage), `inMemoryInbox()`, `inMemoryBudgetLedger()`, `inMemoryStreamLog()` |
| `eharness/mcp` | Accepted | `mcpServerSource()`, `remoteMcpSource()`, `listRemoteMcpTools()`, `bearerAuthProvider()` (optional peer `@ai-sdk/mcp`) |
| `eharness/todos` | Draft | `todos()` plugin (`todo_write`, `data-todos.list`), `latestTodos()`, `renderTodos()`, `openTodos()` |
| `eharness/memory` | Draft | `memory()` plugin: memory files under app-chosen roots, pinned files, pre-compaction flush |
| `eharness/guard` | Draft | `guard()`: an LLM approval judge that can only tighten (deny or ask a person) |
| `eharness/group` | Draft | `group()` and `routeGroupMessage()`: should-respond gating, pending history, anti-loop |
| `eharness/openapi` | Draft | `openApiSource()`: OpenAPI 3.0 / 3.1 JSON as tools |
| `eharness/permissions` | Draft | `permissions()`, `createPermissionEngine()`: rules, modes, plan mode, shell command analysis |
| `eharness/subagent` | Draft | `subagent()` (`agent` tool; approvals inline / park / policy), `subagentChild()`, `pendingSubagentApprovals()`, `reconcileSubagentWaits()`, `reconcileBackgroundChildren()` |
| `eharness/ask` | Draft | `ask()` (`ask_user_question`), `pendingQuestions()`, `answerOutput()` |
| `eharness/web` | Draft | `webFetch()` (SSRF guards, Markdown) and `webSearch()` (provider-agnostic) |
| `eharness/web/node` | Draft, Node-only | `nodeResolveHost()`: a DNS resolver for `webFetch` |
| `eharness/code` | Draft | `code()` (`run_python`, `install_packages`): Python over the virtual file system with incremental sync and compare-and-set write-back, `syncedSandbox()` |
| `eharness/shell` | Draft, Node-only | `shell()` (`bash`, background tasks), `localSandbox()`, `detectOsSandbox()` |
| `eharness/providers` | Draft (0.8) | `createProviderManager()`, provider definitions, `inMemoryProfileStore()`, `sealedProfileStore()`, `formSpec()`, `SecretVault`s, catalog loaders |
| `eharness/connectors` | Draft (0.8) | `createConnectorService()`, `defineConnector()`, setup flows, enablement, `activateConnectors()`, built-in connectors |
| `eharness/activity` | Draft (0.8) | `activity()` plugin, `ActivityStore` port, SSE helpers, `listAttention()` / `answerAttention()` |
| `eharness/http` | Draft (0.8) | `createHarnessHttp()`: a `fetch(Request)` handler for chat, resume, sessions, attention and activity behind one `authorize` hook; `openAccess` |
| `eharness/client` | Draft (0.8) | `createHarnessClient()`, `createHarnessTransport()`, `createChatSession()`, `createActivityFeed()`, `createAttentionList()` |
| `eharness/client/react` | Draft (0.8) | `createReactBindings(React)`, `chatBridgeOf()` |
| `eharness/testing` | Accepted | `scriptedModel()`, `scriptedProvider()` and conformance suites for your adapters |

The full table with source files is in [architecture](docs/architecture.md#2-package--exports).

### Deployment profiles

Every shipped module serves three product shapes: an autonomous server (no human; policy and
budgets), a single-process interactive app (CLI or TUI), and a split web/server app (pending state
in storage, answers from any instance). See
[ADR-0034](docs/decisions/0034-deployment-profiles.md).

## Examples

Every example runs offline (`bun examples/<file>`) and is typechecked and executed in CI, except
`next-route.ts` (route handlers: run `next-route.demo.ts` instead), the Postgres examples (they
need `DATABASE_URL` and skip otherwise) and the two apps, `team/` and `coder/`.

| Example | Shows |
|---|---|
| [`quick-start.ts`](examples/quick-start.ts) | the code above |
| [`tool-context.ts`](examples/tool-context.ts) | a tool that reads the running chat and streams custom data parts |
| [`basic-cli.ts`](examples/basic-cli.ts) | terminal rendering with `readUIMessageStream`, filesystem plugin |
| [`next-route.ts`](examples/next-route.ts) | Next.js routes and a `useChat` client (not runnable alone) |
| [`next-route.demo.ts`](examples/next-route.demo.ts) | the offline demo of `next-route.ts`: `bun examples/next-route.demo.ts` (approvals, resume) |
| [`structured-output.ts`](examples/structured-output.ts) | a typed, validated final answer with `send(…, { output })`: tool mode and native mode |
| [`wrap-plugin.ts`](examples/wrap-plugin.ts) | `wrapPlugin()`: per-request configuration of `guard()` (judge per request, trusted requests, decision log) |
| [`plugin-authoring.ts`](examples/plugin-authoring.ts) | a plugin with a service, tool, data part, hooks and state |
| [`long-running.ts`](examples/long-running.ts) | the progress guard (`'stuck'`) and the wrap-up step (`'max-steps'`) |
| [`context-prune.ts`](examples/context-prune.ts) | view-only pruning of old tool outputs (`compaction.prune`) and the thrash stop (`'context-thrash'`) |
| [`budget-and-cost.ts`](examples/budget-and-cost.ts) | `modelsDevCatalog`, `costUsd` per step/turn/session, nested `addUsage`, USD budgets (`'cost-cap'`) |
| [`risk-approvals.ts`](examples/risk-approvals.ts) | tool risk, `approval.risk`, an inbox from `pending`, `respond()` with `actor`, `approval.decided` audit |
| [`todos.ts`](examples/todos.ts) | the `todos()` plugin with `enforce`, rendering `data-todos.list`, `latestTodos()` |
| [`compaction-flush.ts`](examples/compaction-flush.ts) | pre-compaction flush: `compaction.before`, memory `flushOnCompaction`, the `eh.flush` audit record |
| [`memory.ts`](examples/memory.ts) | the `memory()` plugin: per-user root, read-only org root, pinned profile, `onWrite` audit |
| [`background-events.ts`](examples/background-events.ts) | a job result as a message kind, `inject(…, { wake: true })`, a heartbeat that ends silently |
| [`inbox.ts`](examples/inbox.ts) | two instances sharing a durable inbox: steer, `collect`, Stop across instances |
| [`remote-abort.ts`](examples/remote-abort.ts) | `abort()` from another instance through the state (`setIf`) |
| [`external-wait.ts`](examples/external-wait.ts) | a build tool parks the turn; a webhook in another instance resolves it; a timeout through the inbox |
| [`client-tools.ts`](examples/client-tools.ts) | request-declared client tools and page context, validation, timeouts |
| [`approval-guard.ts`](examples/approval-guard.ts) | an LLM judge denies a prompt-injected exfiltration and escalates an odd call |
| [`group-chat.ts`](examples/group-chat.ts) | two humans and another bot in one chat: mention gating, missed history, loop limit |
| [`openapi-tools.ts`](examples/openapi-tools.ts) | an OpenAPI document as tools: curation, base URL, auth header, risk from the method |
| [`subagent-tool.ts`](examples/subagent-tool.ts) | a tool that runs a child session, streams its progress, reports usage |
| [`json-file-storage.ts`](examples/json-file-storage.ts) | `MessageAdapter` + `StateAdapter` on JSON files |
| [`postgres-storage.ts`](examples/postgres-storage.ts) | Postgres adapters + advisory-lock `SessionLock`. Needs `DATABASE_URL` (skips otherwise). |
| [`postgres-inbox.ts`](examples/postgres-inbox.ts) | Postgres `InboxAdapter` (`FOR UPDATE SKIP LOCKED`, `LISTEN`/`NOTIFY`). Needs `DATABASE_URL` (skips otherwise). |
| [`postgres-budget-ledger.ts`](examples/postgres-budget-ledger.ts) | Postgres `BudgetLedger`: monthly scopes, atomic reservations, conformance. Needs `DATABASE_URL` (skips otherwise). |
| [`custom-fs-adapter.ts`](examples/custom-fs-adapter.ts) | a `FileSystem` over a key-value store |
| [`team/`](examples/team/README.md) | a team of agents: Bun + Hono + SQLite server and a SvelteKit web app; approvals inbox, routines, connectors (`bun run dev` in `examples/team`) |
| [`coder/`](examples/coder/README.md) | a terminal coding agent (Ink UI): permissions, subagents, todos, compaction, JSON storage |

## Guides

Start with [which module do I need?](docs/guides/start-here.md) (the 33 entry points in three groups,
with stability labels), then [getting started](docs/guides/getting-started.md) and the
[guide index](docs/guides/README.md) (every guide, one line each). Often needed:

- Build: [instructions, tools and MCP](docs/guides/tools-and-mcp.md) ·
  [writing a plugin](docs/guides/writing-a-plugin.md) ·
  [writing a storage adapter](docs/guides/writing-a-storage-adapter.md) ·
  [skills](docs/guides/skills.md) · [filesystem](docs/guides/filesystem.md)
- Interactive and safe: [approvals and interaction](docs/guides/approvals-and-interaction.md) ·
  [permissions](docs/guides/permissions.md) · [approval guard](docs/guides/guard.md) ·
  [LLM judge](docs/guides/llm-judge.md)
- Long-running and scaled: [long-running turns](docs/guides/long-running-turns.md) ·
  [models and cost](docs/guides/models-and-cost.md) ·
  [several instances](docs/guides/multi-instance.md) ·
  [observability](docs/guides/observability.md)
- Serve and render: [HTTP server](docs/guides/http-server.md) ·
  [web client](docs/guides/web-client.md) ·
  [rendering data parts](docs/guides/rendering-data-parts.md)
- Ship: [production patterns](docs/guides/production-patterns.md) ·
  [production checklist](docs/guides/production-checklist.md) ·
  [testing](docs/guides/testing.md) · [reference](docs/guides/reference.md) ·
  [upgrading to 0.7 and 0.8](docs/guides/upgrading.md)

Reference: [concept](docs/concept.md) (incl. glossary) · [architecture](docs/architecture.md) ·
[specs](docs/specs) (the contracts) · [decisions (ADRs)](docs/decisions) ·
[contributing](CONTRIBUTING.md)

## Security

eharness checks message shapes, approvals and file paths; identity and authorization are yours.
Check session ownership in every route (including the resume `GET`), pass per-request identity
in `SendOptions.runtime`, add per-user quotas on top of the per-session budgets, and set
`toolErrorText` and `logger` before production. The full list of design-level risks, defaults and
what to do: [production patterns → security](docs/guides/production-patterns.md#security).

## Compatibility

| eharness | ai | zod | @ai-sdk/mcp (optional) | Runtime |
|---|---|---|---|---|
| 0.8.x | ^7.0.137 | ^3.25.76 \|\| ^4.1.8 | ^2.0.73 | Node ≥ 22, Bun |
| 0.7.x | ^7.0.127 | ^3.25.76 \|\| ^4.1.8 | ^2.0.66 | Node ≥ 22, Bun |
| 0.6.x | ^7.0.127 | ^3.25.76 \|\| ^4.1.8 | ^2.0.66 | Node ≥ 22, Bun |
| 0.5.x | ^7.0.127 | ^3.25.76 \|\| ^4.1.8 | ^2.0.66 | Node ≥ 22, Bun |
| 0.4.x | ^7.0.127 | ^3.25.76 \|\| ^4.1.8 | ^2.0.66 | Node ≥ 22, Bun |
| 0.3.x | ^7.0.123 | ^3.25.76 \|\| ^4.1.8 | ^2.0.63 | Node ≥ 22, Bun |
| 0.2.x | ^7.0.123 | ^3.25.76 \|\| ^4.1.8 | ^2.0.63 | Node ≥ 22, Bun |
| 0.1.x | ^7 (≥ 7.0.104 needed in practice) | ^3.25.76 \|\| ^4.1.8 | ^2 | Node ≥ 22, Bun |

A new AI SDK major needs a new eharness minor (0.x) / major (≥ 1.0).

## License

[MIT](LICENSE)
