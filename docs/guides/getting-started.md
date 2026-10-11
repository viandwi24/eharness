# Getting started

From an empty directory to a running agent. Requires Node ≥ 22 or Bun. Terms like *turn*, *step*,
*kind message*, *commit point* and *runtime* are defined in the [glossary](../concept.md#glossary).

## 1. Create a project

```bash
mkdir my-agent && cd my-agent
npm init -y && npm pkg set type=module    # eharness is ESM only
npm install eharness ai zod
```

(`bun init -y && bun add eharness ai zod` works the same way.)

## 2. Write the agent

`agent.ts`:

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

What you declared:

- **`model`** — a gateway string (needs `AI_GATEWAY_API_KEY`) or a provider model such as
  `anthropic('claude-sonnet-4-6')` from `@ai-sdk/anthropic`.
- **`contextWindow`** — used by compaction and the context guard. Set it (or pass `models`, a
  catalog with each model's window and prices — [models and cost](models-and-cost.md)); the
  default (128k) warns once with `W_DEFAULT_CONTEXT_WINDOW`.
- **`tools`** — plain AI SDK tools. **`skills`** — playbooks the model opens on demand
  ([skills guide](skills.md)). **`plugins`** — here the reference `filesystem()` plugin with an
  in-memory file system: the model gets `read_file`, `write_file`, `edit_file`, … tools
  ([filesystem guide](filesystem.md)).

## 3. Run it

```bash
export AI_GATEWAY_API_KEY=…
node agent.ts        # Node ≥ 22.18 strips types itself (22.6–22.17: node --experimental-strip-types agent.ts)
bun agent.ts
```

## 4. Run it without a model (tests, CI)

`eharness/testing` has a scripted model: each entry is one model call.

```ts
import { scriptedModel } from 'eharness/testing'

const model = scriptedModel([
  { toolCalls: [{ toolName: 'get_time', input: {} }] },
  {
    toolCalls: [
      { toolName: 'write_file', input: { path: '/notes/now.md', content: '- 12:00\n' } },
    ],
  },
  { text: 'Saved the note.' },
])
// defineHarnessAgent({ model, … }) — then assert on model.prompts[i] (what the model saw)
```

More in [testing](testing.md): script options, assertions and the conformance suites.

## 5. Tools that use the running chat

A plain `tool()` knows only its input. Write the tool as a function `(ctx) => tool()` and it gets
the session context: which chat it runs in, this turn's user message, your app values, session
state, plugin services, and a typed writer for custom UI data parts.

```ts
import { tool } from 'ai'
import { defineDataPart, defineHarnessAgent } from 'eharness'
import { z } from 'zod/v4'

const agent = defineHarnessAgent({
  model: 'anthropic/claude-sonnet-4.6',
  contextWindow: 200_000,
  dataParts: {
    invoice: defineDataPart({ schema: z.object({ total: z.number(), status: z.string() }) }),
    progress: defineDataPart({ schema: z.object({ percent: z.number() }), transient: true }),
  },
  tools: {
    create_invoice: (ctx) =>
      tool({
        description: 'Create and send an invoice',
        inputSchema: z.object({ total: z.number() }),
        execute: async ({ total }, { toolCallId, messages, abortSignal }) => {
          const userText = ctx.turn?.input?.parts.find((p) => p.type === 'text')?.text
          const userId = String(ctx.runtime.userId)
          ctx.state.set('lastInvoice', total)

          ctx.stream.data('progress', { percent: 50 })
          ctx.stream.data('invoice', { total, status: 'draft' }, { id: toolCallId })
          if (abortSignal?.aborted) return 'Cancelled.'
          ctx.stream.data('invoice', { total, status: 'sent' }, { id: toolCallId })
          return `Invoice sent for ${userId} (${messages.length} messages so far, asked: "${userText}")`
        },
      }),
  },
})

const session = agent.session('chat-1', { runtime: { userId: 'u_42' } })
await session.send('Invoice 120 for me').result
```

- **`ctx.session.id`** / **`ctx.agent.id`**: the chat and agent this call belongs to.
- **`ctx.turn`**: the running turn: `input` (the user message that started it), `model`,
  `abortSignal`, and `addUsage()` for model calls you make inside the tool.
- **`ctx.runtime`**: your own values (user, tenant, request id). Pass them with
  `agent.session(id, { runtime })` and/or `send(input, { runtime })`; both are merged per turn.
  Never trust the model for them.
- **`ctx.state`**: JSON state stored with the session (`get` / `set`).
- **`ctx.services`**: services provided by plugins, e.g. `ctx.services.fs` from `filesystem()`.
- **`ctx.stream.data(name, data, { id })`**: writes a part you declared in `dataParts`; names and
  payloads are type-checked. A persistent part is stored in the assistant message, and writing the
  same `id` again replaces it in place. A `transient` part is only streamed.
  `ctx.stream.write({ type: 'data-…', data })` writes any registered part without typing.
- **The second `execute` argument** comes from AI SDK: `toolCallId`, `messages` (the model
  messages so far) and `abortSignal`.

On the client, `useChat<InferHarnessUIMessage<typeof agent>>()` shows `data-invoice` in
`message.parts` with typed `data`; transient parts arrive in `onData`. Runnable:
[`examples/tool-context.ts`](../../examples/tool-context.ts). Rendering details:
[rendering data parts](rendering-data-parts.md).

## 6. Serve it to `useChat`

`handleChatRequest` turns `useChat`'s request body into `send`, approval answers (`respond`),
`regenerate` or `edit`, and answers with the AI SDK UI message stream. eharness knows only the
session id: authentication and chat ownership are yours.

```ts
import { handleChatRequest } from 'eharness'
import { agent } from './agent' // yours: the agent from step 2

declare function authenticate(req: Request): Promise<{ id: string }> // yours
declare function userOwnsChat(userId: string, chatId: string): Promise<boolean> // yours

export async function POST(req: Request): Promise<Response> {
  const user = await authenticate(req)
  const body = await req.json() // useChat's { id, messages, trigger, messageId }
  if (!(await userOwnsChat(user.id, body.id))) return new Response(null, { status: 404 })
  // a busy session answers 409 { error: { code: 'EH_SESSION_BUSY' } } (or pass ifBusy: 'wait')
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
  const run = agent.session(id).attach()
  return run ? run.toStreamResponse() : new Response(null, { status: 204 })
}
```

Use `await run.toResponse()` in POST routes: a failure before the turn is accepted (busy, bad
input, held lock) then answers 409 / 400 / 503 with a JSON body. `toStreamResponse()` streams at
once and carries such failures inside a `200` stream; it is the right call for resume.

On the client: `useChat<InferHarnessUIMessage<typeof agent>>()` types every data part, tool and
message kind. Full routes and client: [`examples/next-route.ts`](../../examples/next-route.ts);
`bun examples/next-route.demo.ts` drives them offline (approvals, resume).

**Which entry point?** `handleChatRequest` (core) is the low-level building block for the one
route you write yourself. `createHarnessHttp()` (`eharness/http`, Draft) is the batteries-included
module: chat, resume, steer, interrupt, session reads, the attention queue and the activity feed
behind one `authorize` hook, as a `fetch(Request)` handler. A script, test or CLI needs neither:
read `run.stream` and `await run.result`. See [which one do I use](reference.md#which-one-do-i-use)
and the [HTTP server](http-server.md) guide.

## 7. More capabilities

Each block below is a compact tour of one area; the linked guide has the full story. Values marked
`// yours: ...` come from your application.

### Cost and budgets

Turns run up to 500 steps by default. Instead of a small step cap, a progress guard stops a turn
that repeats itself or keeps failing (`stop: 'stuck'`), and when the step budget runs out the model
gets one tool-less step to summarize what is done and what is left. Give the agent prices and it
tracks the estimated cost of every turn and enforces USD budgets:

```ts
import { defineHarnessAgent, modelsDevCatalog } from 'eharness'
import { todos } from 'eharness/todos'

declare const modelsDevJson: unknown // yours: models.dev's api.json, fetched and cached by your app

const models = modelsDevCatalog(modelsDevJson) // eharness never fetches anything itself

const agent = defineHarnessAgent({
  model: 'anthropic/claude-sonnet-4.6',
  models, // context window + prices per model (or your own record / function)
  budget: { maxTurnUsd: 2, maxSessionUsd: 20 }, // used up: stop 'cost-cap' (W_BUDGET at 80%)
  loop: { maxSteps: 500, wrapUp: true, progress: { repeats: 3 } }, // the defaults
  plugins: [todos({ enforce: true })], // a checklist tool; keep going while todos are open
})

const result = await agent.session('job-1').send('Migrate the test suite to Vitest').result
console.log(result.stop, result.usage.costUsd) // 'complete' | 'stuck' | 'max-steps' | 'cost-cap' | ...
```

Cost also appears per step (`step.end` hook, `costUsd`), live in `data-eh.usage`, and on stored
messages (`metadata.eharness.usage.costUsd`). Guides: [long-running turns](long-running-turns.md) ·
[models and cost](models-and-cost.md) · [todos](todos.md).

### Risk-based approvals with an audit log

Tools declare a risk; the agent decides which risks need a person. Pending approvals carry the
tool input, `respond()` records who answered, and one hook sees every decision:

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
        hooks: {
          'approval.decided': (ctx, d) => console.log(d.toolName, d.approved, d.by, d.actor),
        },
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
[approvals and interaction](approvals-and-interaction.md).

### Waiting for the outside world, browser tools, guard and a spending ledger

```ts
import { defineHarnessAgent, externalTool, handleChatRequest } from 'eharness'
import { guard } from 'eharness/guard'
import { openApiSource } from 'eharness/openapi'
import { inMemoryBudgetLedger } from 'eharness/storage/memory'
import { z } from 'zod/v4'

declare const models: import('eharness').ModelCatalog // yours: prices (see above)
declare const specJson: object // yours: an OpenAPI 3.x document
declare const sessionId: string // yours
declare const waitId: string // yours: from the pending external wait
declare function alert(item: unknown): void // yours

const agent = defineHarnessAgent({
  model: 'anthropic/claude-sonnet-4.6',
  models, // the ledger estimates and charges in USD
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
    openApiSource({ spec: specJson, name: 'orders', baseUrl: 'https://orders.example.com/v1' }),
  ],
  // a cheap judge that can only tighten: deny or ask a person, never approve
  approval: { risk: { read: 'approved', write: 'approved', external: 'approved' } },
  plugins: [guard({ model: 'openai/gpt-5-mini', policy: 'Never delete customer data.' })],
  // spending limits across sessions and instances, reserved before every model call
  budget: {
    ledger: {
      adapter: inMemoryBudgetLedger({ limits: { 'tenant:acme': 50 } }), // yours in production
      scopes: (ctx) => [`tenant:${String(ctx.runtime.tenantId)}`],
    },
  },
  inbox: { retry: { maxAttempts: 5 }, onDeadLetter: (item) => alert(item) }, // poison items stop cycling
})

// A webhook in ANY instance resolves the parked call; the same assistant message continues
await agent.session(sessionId).resolveWait(waitId, { output: { ok: true } })

// The browser declares tools and page context per request: opt-in, validated, untrusted
export async function POST(req: Request): Promise<Response> {
  const body = await req.json()
  return await handleChatRequest(agent.session(body.id), body, {
    clientTools: { allow: ['get_location'], timeoutMs: 120_000 }, // body.clientTools
    pageContext: { maxChars: 4_000 }, // body.pageContext: a turn reminder framed as data
  }).toResponse()
}
```

- **External waits:** `externalTool()` + `session.resolveWait()` park a turn for minutes or days
  and continue it from any instance; timeouts resolve through a timer, a durable inbox item or
  `expireWaits()`. Guide: [external waits](external-waits.md).
- **Frontend tools and page context:** `handleChatRequest(..., { clientTools, pageContext })` accepts
  what the browser declares for one turn, treated as untrusted; an unanswered call times out.
  Guide: [frontend tools](client-tools.md).
- **Risk `'external'`:** MCP `openWorldHint` maps to it (hints only tighten); route it with
  `approval.risk`. Guide: [approvals](approvals-and-interaction.md).
- **`eharness/guard`:** an LLM approval judge on a restricted transcript, with a verdict cache, a
  circuit breaker and fail-closed escalation. Guides: [approval guard](guard.md),
  [LLM judge](llm-judge.md).
- **Budget ledger:** `budget.ledger` reserves and commits cost per app-defined scope across
  sessions; fails closed. Guide: [models and cost](models-and-cost.md#budgets-across-sessions).
- **Inbox dead-letter:** `inbox.retry` and `inbox.onDeadLetter` stop poison items from blocking a
  session. Guide: [several instances](multi-instance.md#poison-items).
- **`eharness/group`:** answer only when addressed, keep what was missed, stop bot-to-bot loops.
  Guide: [group chat](group-chat.md).
- **`eharness/openapi`:** curated OpenAPI operations as tools. Guide: [OpenAPI tools](openapi-tools.md).

### Memory, background work and several instances

```ts
import { defineHarnessAgent } from 'eharness'
import type { InboxAdapter, MessageAdapter, StateAdapter } from 'eharness'
import { filesystem } from 'eharness/filesystem'
import type { FileSystem } from 'eharness/filesystem'
import { memory } from 'eharness/memory'

declare function filesFor(sessionId: string): FileSystem // yours: a file system per chat
declare const messages: MessageAdapter // yours: Postgres, JSON files, ...
declare const state: StateAdapter // yours
declare const inbox: InboxAdapter // yours (optional)

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
await session.enqueue('One more thing...', { mode: 'collect' }) // any instance; one turn per burst
await session.inject('eh.event', { name: 'job', text: 'Export finished.' }, { wake: true })
await session.abort() // stops the turn even when another instance runs it
```

- **Memory:** `eharness/memory` gives the agent memory files under roots your app chooses per
  user, pinned files in every turn, and a pre-compaction **flush** (`compaction.before`) that saves
  facts before a lossy summary. Guide: [memory](memory.md).
- **Context:** `compaction.prune` replaces old tool outputs by placeholders in the request only;
  a turn whose context refills right after a compaction stops with `'context-thrash'`. Guide:
  [compaction](compaction.md).
- **Several instances:** a durable `InboxAdapter` queues, steers, wakes and debounces
  (`collect`) across instances; `abort()` stops a turn anywhere; `ifBusy: 'wait'` and
  `session.idle()` serialize work in one process. Guide: [several instances](multi-instance.md).
- **Structured output:** `send(input, { output: { schema } })` validates the final answer against
  your schema (a `final_answer` tool, or AI SDK `Output.object` with `mode: 'native'`), retries a
  bounded number of times and returns it typed in `result.output` (stop `'output-invalid'` when
  no valid answer came). Guide: [structured output](structured-output.md).
- **Production patterns:** ephemeral context, episodic memory, background events, heartbeats
  with a "silent OK", skills from a database, and the security checklist:
  [production patterns](production-patterns.md).

## 8. Defaults worth knowing

Everything is optional except `model`. The defaults are made for long, autonomous turns:

| Setting | Default | What it does |
|---|---|---|
| `loop.maxSteps` | 500 | step budget per turn (`SendOptions.maxSteps` per call); stop `'max-steps'` |
| `loop.wrapUp` | `true` | when the budget runs out, one more step without tools asks the model for a summary |
| `loop.progress` | `{ repeats: 3, window: 20, errorStreak: 5, toolErrorStreak: 8, nudges: 1 }` | a turn that repeats itself or keeps failing (also a tool that keeps returning `ERROR:` results) gets one reminder, then stops with `'stuck'` |
| `loop.maxIdleContinues` | 3 | `turn.beforeEnd` continuations in a row without progress before they are refused |
| `loop.maxTurnOutputTokens`, `loop.maxContinues`, `loop.turnTimeoutMs` | none | optional hard caps (`'cost-cap'`, `'timeout'`) |
| `loop.persistEachStep` | `true` | the assistant message is saved after every step |
| `storage` | memory adapters | history is lost on restart until you plug in your own |
| `compaction` | `{ summarizeAt: 0.75, keepLast: 4 }` | summarize older turns when the context is 75% full |
| `toolOutput` | `{ maxChars: 50_000, strategy: 'truncate' }` | limit tool results sent to the model |
| `cache` | `{ mode: 'auto' }` | sets Anthropic `cacheControl` for prompt caching (spec 02 §6) |
| `approval.onNewInput` | `'deny'` | a new message denies approvals that are still pending |
| `sessionIdleMs` | 30 min | idle cached sessions are evicted |
| `settings.timeout` | `{ firstChunkMs: 120_000, chunkMs: 120_000 }` | a model stream that goes silent fails the step (`false` turns it off); `settings.maxRetries` defaults to 2 |
| `hooks.timeoutMs`, `toolSources.timeoutMs` | 30 s, 30 s | an awaited hook or a tool source listing that does not settle counts as failed (`W_HOOK_TIMEOUT`, `W_TOOL_SOURCE_FAILED`) |
| `debug.invariants` | off | explicit opt-in (enable it in tests): an invalid saved message throws `EH_INVALID_MESSAGE` |

Nothing limits spending unless you set `budget` (with `models` pricing) or
`loop.maxTurnOutputTokens` — see [long-running turns](long-running-turns.md).

## 9. Next steps

- **Keep history across restarts:** pass `storage: { messages, state }`. The default is in memory;
  see [writing a storage adapter](writing-a-storage-adapter.md) and the JSON-file and Postgres
  examples.
- **Serve a web UI:** step 6 above. For the full set of routes (auth, attention, activity) mount
  `createHarnessHttp()` instead: [which entry point](reference.md#which-one-do-i-use),
  [HTTP server](http-server.md).
- **Stop reasons and errors:** `run.result` resolves with `stop` (`complete`, `tool-pending`,
  `error`, `aborted`, `max-steps`, `stuck`, `cost-cap`, `timeout`, …) and
  `error: { code, message }`. Only `EH_SESSION_BUSY` and `EH_SESSION_CLOSED` are thrown by
  `send()`. Call `await session.ready()` first if you want configuration errors as exceptions.
  Non-fatal problems arrive as warnings (`onWarning`, `W_*` codes, spec 10).
- **Track cost and set budgets:** [models and cost](models-and-cost.md).
- **Plan multi-step work visibly:** the [todos plugin](todos.md).
- **Ask before risky tools run:** [approvals and interaction](approvals-and-interaction.md).
- **Build a real harness:** read the [server walkthrough](walkthrough-server.md) (multi-user, several
  instances, restarts) or the [CLI walkthrough](walkthrough-cli.md), then the
  [production checklist](production-checklist.md).
- **Everything at a glance:** the [reference](reference.md) lists every option and default.
- **Shut down:** `await agent.close()` closes sessions (MCP clients, plugin resources).
