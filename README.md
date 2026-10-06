# eharness

> Build your own agent harness on the [Vercel AI SDK](https://ai-sdk.dev) v7 — plugins, context,
> messages, streaming, sessions and compaction, with storage you plug in.

[![CI](https://github.com/viandwi24/eharness/actions/workflows/ci.yml/badge.svg)](https://github.com/viandwi24/eharness/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/eharness)](https://www.npmjs.com/package/eharness)

**Status: 0.5.** The contracts in [`docs/specs`](docs/specs) are implemented and tested. Before
1.0, breaking changes ship only in minor versions (`0.5 → 0.6`) with a migration note in the
[changelog](CHANGELOG.md), so `^0.5.0` is safe to depend on
([API stability](docs/engineering/api-stability.md)).

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
import { memoryFs } from 'eharness/filesystem/memory'
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
  plugins: [filesystem({ fs: memoryFs() })],
})

const session = agent.session('demo')
const run = session.send('Write the current time to /notes/now.md')
for await (const chunk of run.stream) {
  if (chunk.type === 'text-delta') process.stdout.write(chunk.delta) // or: run.toResponse()
}

const result = await run.result // never rejects: errors end the turn with stop: 'error'
console.log(`\n${result.stop} after ${result.steps} steps`)
console.log(`${(await session.messages()).length} messages stored`)
```

The model string goes through the [AI Gateway](https://vercel.com/docs/ai-gateway)
(`AI_GATEWAY_API_KEY`); any AI SDK provider model (`anthropic('claude-sonnet-4-6')`, …) works too.
This code is [`examples/quick-start.ts`](examples/quick-start.ts); `bun examples/quick-start.ts`
runs it offline with a scripted model. Walkthrough: [getting started](docs/guides/getting-started.md).

### Serve it to `useChat`

```ts
import { handleChatRequest } from 'eharness'

export async function POST(req: Request) {
  const user = await authenticate(req) // yours: eharness knows only the session id
  const body = await req.json() // useChat's { id, messages, trigger, messageId }
  if (!(await userOwnsChat(user.id, body.id))) return new Response(null, { status: 404 })
  // send, approval answers, regenerate and edit — one AI SDK UI message stream;
  // a busy session answers 409 { error: { code: 'EH_SESSION_BUSY' } } (or pass ifBusy: 'wait')
  return handleChatRequest(agent.session(body.id), body, {
    runtime: { userId: user.id }, // per-request values go into the turn, not the cached session
  }).toResponse()
}

// GET /api/chat/[id]/stream — useChat({ resume: true }) replays the running turn
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await authenticate(req)
  if (!(await userOwnsChat(user.id, id))) return new Response(null, { status: 404 }) // same check
  const run = agent.session(id).attach()
  return run ? run.toResponse() : new Response(null, { status: 204 })
}
```

On the client: `useChat<InferHarnessUIMessage<typeof agent>>()` — every data part, tool and
message kind is typed. Full route + client: [`examples/next-route.ts`](examples/next-route.ts).

### Tools that use the running chat and stream custom UI data

Write a tool as a function `(ctx) => tool()` to get the session context, and declare `dataParts`
to stream your own typed UI data from inside the tool:

```ts
import { tool } from 'ai'
import { defineDataPart, defineHarnessAgent } from 'eharness'
import { z } from 'zod/v4'

const agent = defineHarnessAgent({
  model: 'anthropic/claude-sonnet-4.6',
  dataParts: {
    invoice: defineDataPart({ schema: z.object({ total: z.number(), status: z.string() }) }),
    progress: defineDataPart({ schema: z.object({ percent: z.number() }), transient: true }),
  },
  tools: {
    create_invoice: (ctx) =>
      tool({
        inputSchema: z.object({ total: z.number() }),
        execute: async ({ total }, { toolCallId, messages, abortSignal }) => {
          const userText = ctx.turn?.input?.parts.find((p) => p.type === 'text')?.text
          const userId = String(ctx.runtime.userId) // agent.session(id, { runtime: { userId } })
          ctx.state.set('lastInvoice', total) // persisted with the session

          ctx.stream.data('progress', { percent: 50 }) // transient: streamed, never stored
          ctx.stream.data('invoice', { total, status: 'draft' }, { id: toolCallId })
          ctx.stream.data('invoice', { total, status: 'sent' }, { id: toolCallId }) // same id → replaced
          return `Invoice sent for ${userId}`
        },
      }),
  },
})
```

| In a tool | What you get |
|---|---|
| `ctx.session.id`, `ctx.agent.id` | which chat and agent the call belongs to |
| `ctx.turn` | this turn's user message (`input`), model, `abortSignal`, `addUsage()` for nested model calls |
| `ctx.runtime` | your app values (user, tenant, request) from `agent.session(id, { runtime })` and `send(…, { runtime })` |
| `ctx.state` | JSON state stored with the session |
| `ctx.services` | services from plugins, e.g. `ctx.services.fs` |
| `ctx.stream.data(name, data, { id })` | write a declared data part (type-checked); `ctx.stream.write(chunk)` for any registered part |
| 2nd `execute` argument (AI SDK) | `toolCallId`, `messages` (model messages so far), `abortSignal` |

The client sees `data-invoice` in `message.parts` (typed) and transient parts in
`useChat({ onData })`. Runnable: [`examples/tool-context.ts`](examples/tool-context.ts); more in
[rendering data parts](docs/guides/rendering-data-parts.md).

### Long-running turns, cost and budgets

Turns run up to 500 steps by default. Instead of a small step cap, a progress guard stops a turn
that repeats itself (`stop: 'stuck'`), and when the step budget runs out the model gets one
tool-less step to summarize what is done and what is left. Give the agent prices and it tracks the
estimated cost of every turn and enforces USD budgets:

```ts
import { defineHarnessAgent, modelsDevCatalog } from 'eharness'
import { todos } from 'eharness/todos'

// models.dev database, fetched (and cached) by your app — eharness never fetches anything
const models = modelsDevCatalog(await (await fetch('https://models.dev/api.json')).json())

const agent = defineHarnessAgent({
  model: 'anthropic/claude-sonnet-4.6',
  models, // context window + prices per model (or your own record / function)
  budget: { maxTurnUsd: 2, maxSessionUsd: 20 }, // used up → stop 'cost-cap' (W_BUDGET at 80%)
  loop: { maxSteps: 500, wrapUp: true, progress: { repeats: 3 } }, // the defaults
  plugins: [todos({ enforce: true })], // a checklist tool; keep going while todos are open
})

const result = await agent.session('job-1').send('Migrate the test suite to Vitest').result
console.log(result.stop, result.usage.costUsd) // 'complete' | 'stuck' | 'max-steps' | 'cost-cap' | …
```

Cost also appears per step (`step.end` → `costUsd`), live in `data-eh.usage`, and on stored
messages (`metadata.eharness.usage.costUsd`). Guides: [long-running turns](docs/guides/long-running-turns.md) ·
[models and cost](docs/guides/models-and-cost.md) · [todos](docs/guides/todos.md).

### Risk-based approvals

Tools declare a risk; the agent decides which risks need a person. Pending approvals carry the
tool input, `respond()` records who answered, and one hook sees every decision for your audit log:

```ts
import { tool } from 'ai'
import { defineHarnessAgent, definePlugin } from 'eharness'
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
  plugins: [
    definePlugin({
      name: 'audit',
      setup: () => ({
        hooks: { 'approval.decided': (ctx, d) => console.log(d.toolName, d.approved, d.by, d.actor) },
      }),
    }),
  ],
})

const session = agent.session('ops-1')
const { pending } = await session.send('Delete record r1').result // stop: 'tool-pending'
await session.respond({
  approvals: (pending?.approvals ?? []).map((p) => ({
    id: p.approvalId, // p.toolName, p.input and p.risk are there for your inbox UI
    approved: true,
    actor: { id: 'u_7', name: 'Ada' }, // passed to approval.decided, never stored
  })),
}).result
```

With `useChat`, approvals need no server code: `handleChatRequest` calls `respond()`. Guide:
[approvals and interaction](docs/guides/approvals-and-interaction.md).

### Waiting for the outside world, browser tools, budgets and guards (0.5)

```ts
import { defineHarnessAgent, externalTool, handleChatRequest } from 'eharness'
import { approvalGuard } from 'eharness/guard'
import { openApiTools } from 'eharness/openapi'
import { memoryBudgetLedger } from 'eharness/storage/memory'
import { z } from 'zod/v4'

const agent = defineHarnessAgent({
  model: 'anthropic/claude-sonnet-4.6',
  models, // prices (see above): the ledger estimates and charges in USD
  tools: [
    {
      // park the turn on a webhook: no process is held while it waits
      run_build: externalTool({
        description: 'Run a CI build and wait for its result.',
        inputSchema: z.object({ ref: z.string() }),
        outputSchema: z.object({ ok: z.boolean() }),
        timeoutMs: 60 * 60_000,
        onTimeout: { output: { ok: false } },
      }),
    },
    // an OpenAPI document as tools: your base URL, your auth, risk from the HTTP method
    openApiTools(specJson, { name: 'orders', baseUrl: 'https://orders.example.com/v1' }),
  ],
  // a cheap judge that can only tighten: deny or ask a person, never approve
  approval: { risk: { read: 'approved', write: 'approved', external: 'approved' } },
  plugins: [approvalGuard({ model: 'openai/gpt-5-mini', policy: 'Never delete customer data.' })],
  // spending limits across sessions and instances, reserved before every model call
  budget: {
    ledger: {
      adapter: memoryBudgetLedger({ limits: { 'tenant:acme': 50 } }), // yours in production
      scopes: (ctx) => [`tenant:${String(ctx.runtime.tenantId)}`],
    },
  },
  inbox: { retry: { maxAttempts: 5 }, onDeadLetter: (item) => alert(item) }, // poison items stop cycling
})

// A webhook in ANY instance resolves the parked call; the same assistant message continues
await agent.session(sessionId).resolveWait(waitId, { output: { ok: true } })

// The browser declares tools and page context per request — opt-in, validated, untrusted
export async function POST(req: Request) {
  const body = await req.json()
  return handleChatRequest(agent.session(body.id), body, {
    clientTools: { allow: ['get_location'], timeoutMs: 120_000 }, // body.clientTools
    pageContext: { maxChars: 4_000 }, // body.pageContext → a turn reminder framed as data
  }).toResponse()
}
```

- **External waits:** `externalTool()` + `session.resolveWait()` park a turn for minutes or days
  and continue it from any instance; timeouts resolve through a timer, a durable inbox item or
  `expireWaits()`. Guide: [external waits](docs/guides/external-waits.md).
- **Frontend tools and page context:** `handleChatRequest(…, { clientTools, pageContext })` accepts
  what the browser declares for one turn, treated as untrusted; an unanswered call times out.
  Guide: [frontend tools](docs/guides/client-tools.md).
- **Risk `'external'`:** MCP `openWorldHint` maps to it (hints only tighten); route it with
  `approval.risk`. Guide: [approvals](docs/guides/approvals-and-interaction.md).
- **`eharness/guard`:** an LLM approval judge on a restricted transcript, with a verdict cache, a
  circuit breaker and fail-closed escalation. Guide: [approval guard](docs/guides/guard.md).
- **Budget ledger:** `budget.ledger` reserves and commits cost per app-defined scope across
  sessions; fails closed. Guide: [models and cost](docs/guides/models-and-cost.md#budgets-across-sessions).
- **Inbox dead-letter:** `inbox.retry` and `inbox.onDeadLetter` stop poison items from blocking a
  session. Guide: [several instances](docs/guides/multi-instance.md#poison-items).
- **`eharness/group`:** answer only when addressed, keep what was missed, stop bot-to-bot loops.
  Guide: [group chat](docs/guides/group-chat.md).
- **`eharness/openapi`:** curated OpenAPI operations as tools. Guide:
  [OpenAPI tools](docs/guides/openapi-tools.md).

### Memory, background work and several instances (0.4)

```ts
import { defineHarnessAgent } from 'eharness'
import { filesystem } from 'eharness/filesystem'
import { memory } from 'eharness/memory'

const agent = defineHarnessAgent({
  model: 'anthropic/claude-sonnet-4.6',
  plugins: [
    filesystem({ fs: (ctx) => filesFor(ctx.session.id), hiddenPrefixes: ['/memories'] }),
    memory({
      roots: (ctx) => [{ path: `/memories/${String(ctx.runtime.userId)}/`, write: true }],
      flushOnCompaction: true, // save facts to memory right before history is summarized
    }),
  ],
  compaction: { prune: {} }, // drop old large tool outputs from the request before summarizing
  storage: { messages, state, inbox }, // your adapters; the inbox is optional
})

const session = agent.session('chat-1')
await session.enqueue('One more thing…', { mode: 'collect' }) // any instance; one turn per burst
await session.inject('eh.event', { name: 'job', text: 'Export finished.' }, { wake: true })
await session.requestAbort() // stops the turn even when another instance runs it
```

- **Memory:** `eharness/memory` gives the agent memory files under roots your app chooses per
  user, pinned files in every turn, and a pre-compaction **flush** (`compaction.before`) that saves
  facts before a lossy summary. Guide: [memory](docs/guides/memory.md).
- **Context:** `compaction.prune` replaces old tool outputs by placeholders in the request only;
  a turn whose context refills right after a compaction stops with `'context-thrash'`. Guide:
  [compaction](docs/guides/compaction.md).
- **Several instances:** a durable `InboxAdapter` queues, steers, wakes and debounces
  (`collect`) across instances; `requestAbort()` stops a turn anywhere; `ifBusy: 'wait'` and
  `session.idle()` serialize work in one process. Guide: [several instances](docs/guides/multi-instance.md).
- **Structured output:** `send(input, { output: { schema } })` validates the final answer against
  your schema (a `final_answer` tool, or AI SDK `Output.object` with `mode: 'native'`), retries a
  bounded number of times and returns it typed in `result.output` (stop `'output-invalid'` when
  no valid answer came). Guide: [structured output](docs/guides/structured-output.md).
- **Production patterns:** ephemeral context, episodic memory, background events, heartbeats
  with a "silent OK", skills from a database, and the security checklist:
  [production patterns](docs/guides/production-patterns.md).

## Why

AI SDK gives you `streamText`, tools, `UIMessage` and UI streams. Every serious agent then
re-implements the same harness around them: a step loop, prompt assembly, skills, MCP lifecycle,
history that survives restarts, compaction, custom UI data. **eharness** is that skeleton, kept
thin and idiomatic:

- **Plugins** bundle tools, skills, instructions, hooks, services and typed UI data parts.
- **Static or dynamic, your choice:** declare tools/skills/instructions as constants, or load them
  at runtime (per user, per turn, from a database, from MCP).
- **One stream protocol:** the AI SDK UI message stream — works with `useChat` out of the box.
- **Messages are `UIMessage`s:** custom messages (compaction markers, events) are ordinary messages
  with typed data parts.
- **Storage is yours:** a two-method `MessageAdapter`; the library ships memory adapters and
  conformance tests so your Postgres/JSON/Redis adapter is provably correct.
- **Compaction built in:** summarize + keep tail + guard, stored as data, one-query cold loads,
  automatic recovery when the provider says the context is too long.
- **Long-running turns:** 500 steps by default, a progress guard instead of a small step cap
  (`'stuck'`), a wrap-up summary when the step budget runs out, `turn.beforeEnd` continuations
  bounded by progress.
- **Cost you can see and cap:** a model catalog (your record, a function, or
  [models.dev](https://models.dev) via `modelsDevCatalog`) supplies context windows and prices;
  every turn records `costUsd`; `budget` stops turns and sessions in USD; subagent usage counts
  too (`ctx.turn.addUsage`).
- **Interactive and safe:** tool approvals by policy or by tool risk (`read` / `write` / `external` /
  `destructive`), an `approval.decided` audit hook and `actor` on answers, client-side tools,
  regenerate/edit, steering while the agent works, background wake-ups, crash recovery.
- **Built for several instances:** session locks, compare-and-set state, a durable inbox for
  queue / steer / wake / collect across processes, and a Stop button that reaches the instance
  running the turn.
- **Memory that survives compaction:** file-based memory under app-chosen roots, pinned files,
  and a pre-compaction flush; old tool outputs are pruned before anything is summarized.
- **Tools that know the chat:** `(ctx) => tool()` gets the session, the turn's input, your runtime
  values, state, services, and a typed writer for custom UI data parts.
- **Batteries included, optional:** a todos plugin (`eharness/todos`), a memory plugin
  (`eharness/memory`), a filesystem plugin with skills autoload, MCP servers as tool sources, a
  scripted test model and conformance suites.
- **Waits that outlive the process (0.5):** a tool can park the turn on a webhook, a job or a
  person (`externalTool()`, `resolveWait()`), and a browser can declare its own tools and page
  context per request, safely opt-in.
- **Guarded and capped across sessions (0.5):** an LLM approval guard that can only tighten
  (`eharness/guard`), a `BudgetLedger` port for per-user / tenant limits, `'external'` tool risk,
  and a dead-letter for poison inbox items.
- **Beyond one-to-one chat (0.5):** group-chat gating and anti-loop (`eharness/group`) and
  OpenAPI operations as tools (`eharness/openapi`).
- **Prompt-cache friendly:** stable instructions and tool order; volatile context goes into
  per-turn and per-step reminders.

## Entry points

| Import | Contents |
|---|---|
| `eharness` | `defineHarnessAgent`, `definePlugin`, `defineSkill`, `defineSkillSource`, `defineToolSource`, `defineDataPart`, `defineMessageKind`, `handleChatRequest`, `externalTool`, `toolTraits`, `modelsDevCatalog`, `lookupModel`, `computeCost`, errors, fixed texts, types |
| `eharness/filesystem` | `FileSystem` contract, `filesystem()` plugin (file tools, skills autoload), helpers |
| `eharness/filesystem/memory` | `memoryFs()` |
| `eharness/storage/memory` | `memoryMessages()`, `memoryState()` (the default storage), `memoryInbox()`, `memoryBudgetLedger()` |
| `eharness/mcp` | `mcpServer()` tool source (optional peer `@ai-sdk/mcp`) |
| `eharness/todos` | `todos()` plugin (`todo_write` tool, `data-todos.list`), `latestTodos()`, `renderTodos()`, `openTodos()` |
| `eharness/memory` | `memory()` plugin (memory files under app-chosen roots, pinned files, pre-compaction flush), `executeMemoryCommand()` |
| `eharness/guard` | `approvalGuard()` plugin: an LLM judge on the approval chain that can only tighten (deny / ask a person) |
| `eharness/group` | `groupChat()` plugin and `routeGroupMessage()`: should-respond gating, pending history, speaker metadata, bot-to-bot anti-loop |
| `eharness/openapi` | `openApiTools()` tool source (OpenAPI 3.0 / 3.1 JSON → tools), `riskFromMethod()` |
| `eharness/testing` | `scriptedModel()` and conformance suites for your adapters (messages, state, inbox, budget ledger, file system, skill source, ids) |

## Examples

Every example runs offline (`bun examples/<file>`) and is typechecked and executed in CI.

| Example | Shows |
|---|---|
| [`quick-start.ts`](examples/quick-start.ts) | the code above |
| [`tool-context.ts`](examples/tool-context.ts) | a tool that reads the running chat and streams custom data parts |
| [`basic-cli.ts`](examples/basic-cli.ts) | terminal rendering with `readUIMessageStream`, filesystem plugin |
| [`next-route.ts`](examples/next-route.ts) · [`.demo.ts`](examples/next-route.demo.ts) | Next.js routes, `useChat` client, approvals, resume |
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
| [`remote-abort.ts`](examples/remote-abort.ts) | `requestAbort()` from another instance through the state (`setIf`) |
| [`external-wait.ts`](examples/external-wait.ts) | a build tool parks the turn; a webhook in another instance resolves it; a timeout through the inbox |
| [`client-tools.ts`](examples/client-tools.ts) | request-declared client tools and page context, validation, timeouts |
| [`approval-guard.ts`](examples/approval-guard.ts) | an LLM judge denies a prompt-injected exfiltration and escalates an odd call |
| [`group-chat.ts`](examples/group-chat.ts) | two humans and another bot in one chat: mention gating, missed history, loop limit |
| [`openapi-tools.ts`](examples/openapi-tools.ts) | an OpenAPI document as tools: curation, base URL, auth header, risk from the method |
| [`subagent-tool.ts`](examples/subagent-tool.ts) | a tool that runs a child session, streams its progress, reports usage |
| [`json-file-storage.ts`](examples/json-file-storage.ts) | `MessageAdapter` + `StateAdapter` on JSON files |
| [`postgres-storage.ts`](examples/postgres-storage.ts) | Postgres adapters + advisory-lock `SessionLock` |
| [`postgres-inbox.ts`](examples/postgres-inbox.ts) | Postgres `InboxAdapter` (`FOR UPDATE SKIP LOCKED`, `LISTEN`/`NOTIFY`) |
| [`postgres-budget-ledger.ts`](examples/postgres-budget-ledger.ts) | Postgres `BudgetLedger`: monthly scopes, atomic reservations, conformance |
| [`custom-fs-adapter.ts`](examples/custom-fs-adapter.ts) | a `FileSystem` over a key-value store |

## Guides

[Getting started](docs/guides/getting-started.md) ·
[Instructions, tools and MCP](docs/guides/tools-and-mcp.md) ·
[Writing a plugin](docs/guides/writing-a-plugin.md) ·
[Writing a storage adapter](docs/guides/writing-a-storage-adapter.md) ·
[Running several instances](docs/guides/multi-instance.md) ·
[Production patterns](docs/guides/production-patterns.md) ·
[Rendering data parts](docs/guides/rendering-data-parts.md) ·
[Skills](docs/guides/skills.md) ·
[Filesystem](docs/guides/filesystem.md) ·
[Context and compaction](docs/guides/compaction.md) ·
[Approvals and interaction](docs/guides/approvals-and-interaction.md) ·
[Approval guard](docs/guides/guard.md) ·
[Frontend tools and page context](docs/guides/client-tools.md) ·
[External waits](docs/guides/external-waits.md) ·
[Long-running turns](docs/guides/long-running-turns.md) ·
[Structured output](docs/guides/structured-output.md) ·
[Models and cost](docs/guides/models-and-cost.md) ·
[Todos](docs/guides/todos.md) ·
[Memory](docs/guides/memory.md) ·
[OpenAPI tools](docs/guides/openapi-tools.md) ·
[Group chat](docs/guides/group-chat.md) ·
[Subagents](docs/guides/subagents.md) ·
[Testing](docs/guides/testing.md) ·
[Reference](docs/guides/reference.md)

Reference: [concept](docs/concept.md) · [architecture](docs/architecture.md) ·
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
| 0.5.x | ^7.0.127 | ^3.25.76 \|\| ^4.1.8 | ^2.0.66 | Node ≥ 22, Bun |
| 0.4.x | ^7.0.127 | ^3.25.76 \|\| ^4.1.8 | ^2.0.66 | Node ≥ 22, Bun |
| 0.3.x | ^7.0.123 | ^3.25.76 \|\| ^4.1.8 | ^2.0.63 | Node ≥ 22, Bun |
| 0.2.x | ^7.0.123 | ^3.25.76 \|\| ^4.1.8 | ^2.0.63 | Node ≥ 22, Bun |
| 0.1.x | ^7 (≥ 7.0.104 needed in practice) | ^3.25.76 \|\| ^4.1.8 | ^2 | Node ≥ 22, Bun |

A new AI SDK major needs a new eharness minor (0.x) / major (≥ 1.0).

## License

[MIT](LICENSE)
