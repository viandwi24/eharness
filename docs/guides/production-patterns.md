# Production patterns

Patterns for running an eharness agent behind a real product: what goes into the prompt without
being stored, long-term and episodic memory, events from background jobs, several server
instances, poison items, long waits and webhooks, cross-session budgets, an LLM approval guard,
browser tools, group bots, OpenAPI tools, scheduled check-ins, skills from a database, and the
security decisions eharness leaves to the application. Every pattern uses public API only; most of
it existed before 0.4.0, the rest is new in 0.4.0 / 0.5.0 and linked to its guide.

Rule of thumb: **eharness runs turns; your application owns everything around them** — users and
permissions, schedules, job queues, databases, and which session a request may touch.

- [Ephemeral context](#ephemeral-context)
- [Episodic and long-term memory](#episodic-and-long-term-memory)
- [Background events](#background-events)
- [Several instances](#several-instances)
- [Poison items and alerting](#poison-items-and-alerting)
- [Long waits and webhooks](#long-waits-and-webhooks)
- [Cross-session budgets](#cross-session-budgets)
- [Guard in production](#guard-in-production)
- [Browser tools and page context](#browser-tools-and-page-context)
- [Group bots](#group-bots)
- [OpenAPI tools](#openapi-tools)
- [Scheduling and heartbeats](#scheduling-and-heartbeats)
- [Skills from a database](#skills-from-a-database)
- [Pipeline workers and tool-heavy agents](#pipeline-workers-and-tool-heavy-agents)
- [Security](#security)

## Ephemeral context

Context that is true **now** — the members of a group chat, a live price, memories retrieved for
this message — should reach the model without becoming history. Where you put it decides whether
it is stored and whether the provider's prompt cache survives:

| Mechanism | Evaluated | Stored? | Placed |
|---|---|---|---|
| static `instructions` (string) | at boot | no (config) | system block 1 — cached prefix |
| instruction function (`refresh: 'session'`, the default) | first turn of the session, then cached | no | system block 2 — cached per session |
| `{ text: fn, refresh: 'turn' }` instruction | every turn start | **no** | turn reminder (`<system-reminder>` before the user message) |
| `step.prepare` → `{ reminder }` | every step | **no** | step reminder (after the last message, this step only) |
| `input.submit` → `{ context }` | once per user input | **yes**: extra `text` parts of the user message (`metadata.eharness.augmented`) | in the user message, forever |
| `step.end` → `{ context }` | after a step | **yes**: a `data-eh.input` part of the assistant message | where the model saw it, forever |
| `session.inject(kind, data)` | when you call it | **yes**: a kind message | per the kind's `model` projection |

Use the first four for ephemeral context. The last three are **history**: they are stored, shown
by `session.messages()`, summarized by compaction and replayed to the model in every later turn.
Use them for facts that should stay, never for "now" values or for large retrieved documents.

```ts
import { defineHarnessAgent, definePlugin } from 'eharness'

const retrieved = new Map<string, string>() // turn id → retrieved memories

const recall = definePlugin({
  name: 'recall',
  setup: () => ({
    hooks: {
      // ctx.turn.input (the user message) is set from the first step on
      'step.prepare': async (ctx) => {
        const turn = ctx.turn
        if (turn === undefined) return
        let text = retrieved.get(turn.id)
        if (text === undefined) {
          const query = turn.input?.parts.map((p) => (p.type === 'text' ? p.text : '')).join(' ')
          text = query ? await searchMemories(String(ctx.runtime.userId), query) : ''
          retrieved.set(turn.id, text) // once per turn; the reminder repeats on every step
        }
        return text === '' ? undefined : { reminder: `Relevant memories:\n${text}` }
      },
      'turn.end': (ctx, e) => {
        retrieved.delete(e.turnId)
      },
    },
  }),
})

const agent = defineHarnessAgent({
  model,
  instructions: [
    'You are the team assistant of Acme.', // static: identical for every user and turn
    {
      // live data: recomputed every turn, never stored, outside the cached system prompt
      text: async (ctx) => {
        const members = await groupMembers(String(ctx.runtime.chatId))
        return `Group members right now: ${members.join(', ')}.`
      },
      refresh: 'turn',
    },
  ],
  plugins: [recall],
})
```

Things to know:

- A `refresh: 'turn'` instruction runs **before** the turn's input is normalized: `ctx.turn` is
  set but `ctx.turn.input` is still `undefined` there. Context that depends on the user's message
  (retrieval) belongs in `step.prepare` (as above), where `ctx.turn.input` is set.
- A `step.prepare` reminder is sent with **one** step only; return it on every step that needs it
  (cache the expensive part per turn, as above).
- An instruction function with the default `refresh: 'session'` is evaluated at the first turn of
  a live session and cached until the session is closed or evicted. It must not read per-request
  values (`ctx.runtime.userId` of the request that happened to come first); use
  `refresh: 'turn'` for those.
- Both reminders are invisible to the UI and to storage. To show the user what the agent was told,
  write a transient data part (`ctx.stream.data`) as well.

Contracts: spec 02 §2, §5–§6; spec 05 §3 step 8; spec 01 §5.

## Episodic and long-term memory

**Episodes from compaction.** Every compaction stores an `eh.compaction` marker whose payload has
the `summary` of everything before it. A `compaction.after` hook can copy it into your own
store — a cheap episodic memory of long conversations, searchable from other sessions:

```ts
import { definePlugin } from 'eharness'

const episodes = definePlugin({
  name: 'episodes',
  setup: () => ({
    hooks: {
      'compaction.after': async (ctx, { marker }) => {
        for (const part of marker.parts) {
          if (part.type !== 'data-eh.compaction') continue
          await saveEpisode({
            userId: String(ctx.runtime.userId),
            sessionId: ctx.session.id,
            summary: part.data.summary,
            trigger: part.data.trigger, // 'turn' | 'auto' | 'manual'
            at: marker.metadata?.eharness?.createdAt ?? Date.now(),
          })
        }
      },
    },
  }),
})
```

Retrieve episodes in a later session with the `step.prepare` pattern above. A hook error is
`W_HOOK_FAILED`; the compaction is already stored.

**Save before summarizing.** A summary is lossy. With the memory plugin, the agent gets one
internal, bounded turn to write facts into memory files right before the summarizer runs
(0.4.0, [compaction guide](compaction.md#saving-facts-before-summarizing)):

```ts
import { filesystem } from 'eharness/filesystem'
import { memoryFs } from 'eharness/filesystem/memory'
import { memory } from 'eharness/memory'

const plugins = [
  filesystem({ fs: memoryFs(), hiddenPrefixes: ['/memories'] }),
  memory({
    roots: (ctx) => [
      { path: `/memories/users/${String(ctx.runtime.userId)}/`, write: true, label: 'this user' },
      { path: '/memories/org/', label: 'company knowledge (read-only)' },
    ],
    pinned: (ctx) => [`/memories/users/${String(ctx.runtime.userId)}/profile.md`],
    flushOnCompaction: true, // compaction.before → flush with the memory write tools
  }),
]
```

The flush leaves no trace in the conversation; a model-invisible `eh.flush` record (trigger,
tool names and statuses, usage, cost) is stored for audits. Roots are resolved per turn from
`ctx.runtime`, so the application decides whose memory a turn may read and write. Guides:
[memory](memory.md), [compaction](compaction.md). Contracts: spec 06 §3, §5.2a; spec 14.

## Background events

Results of background jobs, messages from other agents and scheduled reminders reach a session as
**message kinds**: ordinary stored messages with one typed data part, which the UI renders and the
model sees through the kind's projection.

```ts
import { defineHarnessAgent, defineMessageKind } from 'eharness'
import { z } from 'zod/v4'

const agent = defineHarnessAgent({
  model,
  messageKinds: {
    jobResult: defineMessageKind({
      role: 'user',
      schema: z.object({ job: z.string(), status: z.enum(['ok', 'failed']), summary: z.string() }),
      model: (d) => `<job-result job="${d.job}" status="${d.status}">${d.summary}</job-result>`,
    }),
  },
})

// in your job worker, when the job finishes:
const session = agent.session(chatId)
const { run } = await session.inject(
  'jobResult',
  { job: 'export', status: 'ok', summary: 'Exported 1 204 rows.' },
  { wake: true },
)
const result = await run?.result // a wake turn started here; undefined when delivered inline
```

| Call | Session idle | A turn is running |
|---|---|---|
| `inject(kind, data)` | stored; the model sees it at the next turn | stored; seen at the next turn |
| `inject(kind, data, { deliver: 'next-step' })` | stored; seen at the next turn | also delivered into the running turn at its next step boundary (`data-eh.input { source: 'event' }`) |
| `inject(kind, data, { wake: true })` | stored, and a no-input turn starts now (`run` returned) | delivered at the next step boundary; if the turn ends first, a wake turn is queued |

A wake is never lost: when it cannot be delivered inline, a wake turn is queued, and it waits for
pending approvals (a background event never denies an approval the user is looking at). With a
durable inbox, a wake while the turn runs in **another instance** is handed to that instance
([several instances](multi-instance.md)). Agent-to-agent messages are the same mechanism: agent A's
tool injects a kind into agent B's session. Use `eh.event` (`{ name, text, data? }`) when you do
not need a schema of your own.

Runnable: [`examples/background-events.ts`](../../examples/background-events.ts). Guide:
[approvals and interaction](approvals-and-interaction.md#background-events-and-wake-ups).
Contracts: spec 03 §5, spec 11 §6.3.

## Several instances

Behind a load balancer any instance may get any session's request. What each guarantee needs
([several instances](multi-instance.md) has the details):

| Need | Provide |
|---|---|
| Exactly one running turn per session | a `SessionLock`, e.g. a Postgres advisory lock (`postgresLock` in [`examples/postgres-storage.ts`](../../examples/postgres-storage.ts)) |
| Exactly-once approvals, no lost state updates | `StateAdapter.setIf` (compare-and-set on `rev`) |
| See history written by another instance | `MessageAdapter.lastId` |
| Take over turns of a crashed instance | nothing: `recovery.staleMs` (default 120 s) marks a turn without heartbeat as interrupted |
| Stop a turn running elsewhere (0.4.0) | `StateAdapter.setIf` (polled every `recovery.abortPollMs`), or an inbox |
| Queue, steer, wake and collect across instances (0.4.0) | `storage.inbox` (`InboxAdapter`, e.g. [`examples/postgres-inbox.ts`](../../examples/postgres-inbox.ts)) |

```ts
import { defineHarnessAgent } from 'eharness'

const agent = defineHarnessAgent({
  model,
  storage: { messages, state, inbox }, // state with setIf; inbox optional
  recovery: { staleMs: 120_000, abortPollMs: 2_000 }, // the defaults
})
const session = agent.session(chatId, { lock: postgresLock(pool) })

await session.requestAbort('user pressed stop') // → { target: 'local' | 'remote' | 'idle' | 'unsupported' }
await session.enqueue('Also check the invoices.', { mode: 'steer' }) // → { inboxId, target }
```

In one process, a second message while a turn runs is decided by `ifBusy`: `'reject'` (default,
`EH_SESSION_BUSY`), `'queue'`, `'steer'`, `'collect'` (debounce a burst into one turn) or
`'wait'` (0.4.0: wait for the running turn and the queue, then run). `session.idle()` resolves
when nothing runs or waits. `handleChatRequest` never throws on a busy session: it answers
**409** `{ error: { code: 'EH_SESSION_BUSY', message } }`. The stream of a turn ends only after the
turn is persisted, so a client that saw `finish` can send again at once.

A chat route with an ownership check, busy handling and cross-instance hand-off:

```ts
import { handleChatRequest } from 'eharness'

export async function POST(req: Request): Promise<Response> {
  const user = await authenticate(req) // your auth; eharness knows only the session id
  const body = await req.json()
  if (!(await userOwnsChat(user.id, body.id))) return new Response(null, { status: 404 })

  const session = agent.session(body.id)
  const { activeTurn } = await session.stats()
  if (activeTurn !== null && !session.running) {
    // the turn runs in another instance: hand the message to it through the inbox
    const { inboxId } = await session.enqueue(body.messages.at(-1), { mode: 'steer' })
    return Response.json({ inboxId }, { status: 202 })
  }
  // same instance: wait for the running turn instead of answering 409
  return handleChatRequest(session, body, {
    ifBusy: 'wait',
    runtime: { userId: user.id }, // per-request identity: SendOptions.runtime
  }).toResponse()
}
```

Guides: [several instances](multi-instance.md), [writing a storage adapter](writing-a-storage-adapter.md),
[long-running turns](long-running-turns.md#stopping-a-turn-from-another-instance). Contracts: spec 05
§6–§9.1, §12; ADR-0021, ADR-0024.

## Poison items and alerting

A queue item that can never succeed must not block its session forever (0.5.0). Turn on
`inbox.retry`, page a human from `onDeadLetter`, and watch the counts:

```ts
import { defineHarnessAgent } from 'eharness'

const agent = defineHarnessAgent({
  model,
  storage: { messages, state, inbox },
  inbox: {
    retry: { maxAttempts: 5 }, // needs an adapter that passes inboxAdapterConformance(…, { requireRetry: true })
    onDeadLetter: async (item) => {
      await alerts.page(`dead inbox item ${item.id} (${item.kind}): ${item.reason}`)
    },
  },
})

// a dashboard / health check: dead and delayed items are the numbers to alert on
const stats = await inbox.stats?.()
if (stats !== undefined && stats.dead > 0) await alerts.warn(`${stats.dead} dead inbox items`)
```

- A dead item is **kept** by the adapter (`listDead()`), never dropped; fix the cause, then
  `redrive(ids)` (an admin route, not a core method).
- Retries make side effects **at-least-once**: mark safe tools `metadata: { idempotent: true }` and
  give the rest an idempotency key (the `waitId` of an external wait, the `inboxId` of a message).
- Leave `retry` off for a 0.4-era custom adapter: it may not honour `release` options and would
  dead-letter healthy items behind a long turn.

Guide: [several instances → poison items](multi-instance.md#poison-items). Contract: spec 05 §12
rules 11–15; ADR-0026.

## Long waits and webhooks

A CI build, a payment confirmation or a human review takes longer than a request. Park the turn
instead of holding a worker (0.5.0): the tool is an `externalTool()`, the result arrives at **any**
instance through `resolveWait()`, and a sweeper or an inbox timer expires waits nobody answers.

```ts
import { defineHarnessAgent, externalTool } from 'eharness'
import { z } from 'zod/v4'

const agent = defineHarnessAgent({
  model,
  storage: { messages, state, inbox }, // the inbox makes timeouts durable across instances
  tools: {
    run_build: externalTool({
      description: 'Run a CI build for a git ref and wait for the result.',
      inputSchema: z.object({ ref: z.string() }),
      outputSchema: z.object({ ok: z.boolean(), summary: z.string() }),
      start: async ({ ref }, { waitId }) => {
        // the waitId is stable per tool call: use it as the idempotency key of the outside job
        await ci.trigger(ref, { idempotencyKey: waitId })
        return { correlationId: `ci:${ref}` }
      },
      timeoutMs: 60 * 60_000,
      onTimeout: { output: { ok: false, summary: 'The build did not report back in time.' } },
    }),
  },
})

// POST /webhooks/ci — verify the sender first: the core cannot authenticate a webhook
export async function POST(req: Request): Promise<Response> {
  const event = await verifySignature(req) // yours; maps the provider payload to ids
  const outcome = await agent.session(event.sessionId).resolveWait(event.waitId, {
    output: { ok: event.ok, summary: event.summary },
  })
  return Response.json({ status: outcome.status }) // replays and unknown waits are fine: answer 200
}

// without an inbox, a cron sweeper applies the timeouts
for (const id of await sessionsWithOpenWaits()) await agent.session(id).expireWaits()
```

- **Who may resolve what** is your decision: the browser never can (`handleChatRequest` ignores
  such answers). Keep a map from your correlation id to `sessionId` + `waitId`.
- **Resolved exactly once:** result, timeout and cancellation (new user input) race through one
  compare-and-set; a replayed webhook is `already-resolved`.
- **Crashes:** the parked call is answered, never re-executed. The in-process timer is capped at
  2^31 ms; longer waits need the inbox timer or the sweeper.
- Show open waits in a UI with `session.pendingWaits()`; audit with the `wait-resolved` event.

Guide: [external waits](external-waits.md). Contract: spec 11 §4.2; ADR-0027. Runnable:
[`examples/external-wait.ts`](../../examples/external-wait.ts).

## Cross-session budgets

`maxTurnUsd` / `maxSessionUsd` cap one turn and one session; a user with many sessions is not
capped (see [security](#budgets-are-per-turn-and-per-session)). `budget.ledger` (0.5.0) is the
inside-the-loop counterpart for **per-user, per-tenant, per-month** limits:

```ts
import { defineHarnessAgent } from 'eharness'

const agent = defineHarnessAgent({
  model,
  models, // prices
  settings: { maxOutputTokens: 4_000 }, // tighter reservations than the 4 096 default estimate
  budget: {
    maxTurnUsd: 2,
    ledger: {
      adapter: postgresLedger, // yours: periods, prices and alerts live there
      scopes: (ctx) => [`tenant:${String(ctx.runtime.tenantId)}`, `user:${String(ctx.runtime.userId)}`],
      onError: 'stop', // the default: a ledger outage ends the turn instead of spending unchecked
    },
  },
})

// a UI or a pre-turn gate: read-only status of the same scopes
const { ok, scopes } = await postgresLedger.check([`user:${userId}`])
```

- **Reserve before, commit after:** N sessions cannot overshoot by N steps, only by how far an
  estimate was off. A refused reservation stops the turn with `'cost-cap'` and `W_BUDGET`
  (`details.scope: 'ledger'`, `ledgerScope`) before the model is called.
- **Nested usage counts:** the guard's judge, compaction and flush, `ctx.turn.addUsage`.
- **Policy is yours:** scope names are opaque strings. Hierarchy, monthly reset, price lists, soft
  limits and alerts belong in the adapter (see
  [`examples/postgres-budget-ledger.ts`](../../examples/postgres-budget-ledger.ts)); run
  `budgetLedgerConformance` against it.
- A gateway (LiteLLM, Portkey, OpenRouter) stays a good last line of defence.

Guide: [models and cost → budgets across sessions](models-and-cost.md#budgets-across-sessions).
Contract: spec 12 §4.1; ADR-0029.

## Guard in production

`approvalGuard()` (0.5.0, `eharness/guard`) is a second model on the approval chain that can only
**tighten**: deny a call with a reason the agent reads, or ask a person. Treat it as one layer
after deterministic rules, not a replacement:

```ts
import { defineHarnessAgent } from 'eharness'
import { approvalGuard } from 'eharness/guard'

const agent = defineHarnessAgent({
  model,
  models,
  approval: {
    // deterministic rules first: destructive always asks a person, the guard reviews the rest
    risk: { read: 'approved', write: 'approved', external: 'approved', destructive: 'user-approval' },
  },
  plugins: [
    approvalGuard({
      model: 'openai/gpt-5-mini', // cheap and fast; price it in `models` to see USD
      policy: 'Emails go only to @acme.com addresses the user named. Never delete customer data.',
      skipTools: ['search_docs'], // calls that never need review
      timeoutMs: 10_000, // a slow judge escalates to a person
    }),
  ],
})
```

- **Latency and cost:** one judge call per reviewed, uncached call, before the tool runs.
  Verdicts are cached per session by tool and input; `respond()` continuations never re-judge.
  Judge usage is charged to the turn, so budgets and the ledger see it.
- **Fail closed:** an unavailable judge escalates to a person with `W_GUARD_UNAVAILABLE`; alert
  when it appears often.
- **Breaker:** three consecutive denials escalate the next one to a person (a stuck loop should
  not burn judge calls); tune `maxConsecutiveDenials`.
- **Audit:** `approval.decided` receives guard denials with `by: 'plugin:guard'`.
- **Standing grants:** a person's session-wide `always` turns later guard *escalations* into
  approvals (never a denial). Avoid `remember: 'session'` for tools you want reviewed every time.
- **It is probabilistic.** Keep least-privilege credentials and sandboxes; do not rely on a judge
  for anything you could forbid with a rule.

Guide: [approval guard](guard.md). Contract: spec 15; ADR-0030. Runnable:
[`examples/approval-guard.ts`](../../examples/approval-guard.ts).

## Browser tools and page context

The frontend can run tools the server cannot (read the location, fill a form) and knows what is on
screen. With the opt-in (0.5.0) a request declares both for one turn; the server treats them as
**untrusted input**:

```ts
import { handleChatRequest } from 'eharness'

export async function POST(req: Request): Promise<Response> {
  const user = await authenticate(req)
  const body = await req.json()
  if (!(await userOwnsChat(user.id, body.id))) return new Response(null, { status: 404 })
  return handleChatRequest(agent.session(body.id), body, {
    runtime: { userId: user.id },
    clientTools: { allow: ['get_location', 'open_dialog'], maxTools: 8, timeoutMs: 120_000 },
    pageContext: { maxChars: 4_000 },
  }).toResponse()
}
```

- **Allow-list the names** you handle in the client; reject the rest. Declarations that collide with
  a server tool fail the request.
- **No implied permission:** a declared tool has risk `unknown`; approval policy applies, so
  `approval.risk: { unknown: 'user-approval' }` makes a person confirm browser actions.
- **A closed tab:** `timeoutMs` answers the call with `CLIENT_TOOL_TIMED_OUT` (or your
  `onTimeout`) through a timer, an inbox item or `expireWaits()`.
- **Cache:** a changing set of declarations busts the cached prefix (`W_CACHE_BUST`); keep them
  stable per page.
- **Page context is data:** framed with `PAGE_CONTEXT_PREAMBLE`, capped, never stored; do not put
  secrets or instructions you rely on in it.

Guide: [frontend tools and page context](client-tools.md). Contract: spec 11 §7.1; ADR-0028.

## Group bots

A bot in a group chat must not answer everything, must still know what it missed and must not
loop with other bots. `eharness/group` (0.5.0) decides per incoming message; your channel code
supplies the facts:

```ts
import { defineHarnessAgent } from 'eharness'
import { groupChat, routeGroupMessage } from 'eharness/group'

const group = groupChat({ botId, botName: 'Harness', maxBotTurns: { count: 3, windowMs: 60_000 } })
const agent = defineHarnessAgent({ model, plugins: [group] })

export async function onChannelMessage(m: ChannelMessage): Promise<void> {
  const session = agent.session(`telegram:${m.chatId}`, { acceptClientMetadata: true })
  const result = await routeGroupMessage(group, session, {
    text: m.text,
    author: { id: m.authorId, name: m.authorName, isBot: m.isBot },
    mentionsBot: m.mentionsBot, // the channel adapter's facts
    replyToBot: m.replyToBot,
    chatId: m.chatId,
    messageId: m.id,
  })
  if (result.responded) await sendToChannel(m.chatId, result.run)
}
```

- **One session per chat**, with `acceptClientMetadata: true` so the speaker survives in storage
  and the bot-to-bot limit can be derived from history (safe across instances).
- **Missed messages** are stored as the `group.message` kind and handed, framed as data, to the
  next answer exactly once (`historyLimit`).
- **Relevance scoring, personas and "when to chime in"** stay yours (`shouldRespond`).
- Pair with the [memory plugin](memory.md) for a rolling summary, and with
  [`ifBusy: 'collect'`](multi-instance.md) (the helper's default) for message bursts.

Guide: [group chat](group-chat.md). Contract: spec 16; ADR-0031.

## OpenAPI tools

`openApiTools()` (0.5.0, `eharness/openapi`) turns an OpenAPI 3.x JSON document into tools. In
production the rules are about **what you do not expose**:

```ts
import { defineHarnessAgent } from 'eharness'
import { openApiTools } from 'eharness/openapi'

const orders = openApiTools(specJson, {
  name: 'orders',
  baseUrl: 'https://orders.example.com/v1', // yours: the spec's `servers` are ignored
  headers: (ctx) => ({ authorization: `Bearer ${String(ctx.runtime.apiToken)}` }),
  include: { tags: ['orders'] },
  // third-party API: everything that changes state is external
  risk: (op) => (op.method === 'get' ? 'read' : 'external'),
})

const agent = defineHarnessAgent({
  model,
  tools: [orders],
  approval: { risk: { external: 'user-approval', destructive: 'user-approval' } },
})
```

- **Curate:** a handful of well-described operations beat a mirror of the whole API.
- **Credentials:** only through `headers()`, per call, from `ctx.runtime`; never in the spec.
- **Risk and approval:** the default risk comes from the method; decide what a person confirms
  with `approval.risk` or add the [guard](guard.md).
- Failures return as error strings the model can fix; responses are capped.

Guide: [OpenAPI tools](openapi-tools.md). Contract: spec 17; ADR-0032.

## Scheduling and heartbeats

eharness has no scheduler, by design: cron, queues and timers are your infrastructure. A
scheduled job wakes the agent the same way a background job does — `inject(…, { wake: true })` —
and decides what to do with the result.

Most heartbeats find nothing to do. The **silent OK** pattern lets the agent say so without a
message for the user: a tool it calls when there is nothing to report, and a `step.end` hook that
ends the turn right after it.

```ts
import { tool } from 'ai'
import { definePlugin } from 'eharness'
import { z } from 'zod/v4'

const heartbeat = definePlugin({
  name: 'heartbeat',
  setup: () => ({
    instructions:
      'On a heartbeat event, check for work that needs the user. If there is none, call ' +
      'nothing_to_report and write nothing else.',
    tools: {
      nothing_to_report: tool({
        description: 'Call when a heartbeat finds nothing that needs the user.',
        inputSchema: z.object({}),
        execute: async () => 'OK',
      }),
    },
    hooks: {
      'step.end': (_ctx, e) =>
        e.toolCalls.some((call) => call.toolName === 'nothing_to_report')
          ? { stop: 'silent' } // → stop 'plugin:heartbeat:silent'
          : undefined,
    },
  }),
})

// your scheduler, e.g. every 30 minutes per active chat:
async function tick(chatId: string): Promise<void> {
  const { run } = await agent.session(chatId).inject(
    'eh.event',
    { name: 'heartbeat', text: 'Heartbeat: anything that needs the user?' },
    { wake: true },
  )
  const result = await run?.result
  if (result === undefined || result.stop === 'plugin:heartbeat:silent') return // nothing to send
  await notifyUser(chatId, result) // push / email / chat message
}
```

- The heartbeat event and the (empty) wake turn are still stored. To keep the user's chat clean,
  run heartbeats in a separate session (e.g. `` `${chatId}:heartbeat` ``) and inject only real
  findings into the chat session.
- Give unattended turns a budget (`budget.maxTurnUsd`) and a step cap: wake turns take no
  per-call options, so they run with `loop.maxSteps` (use a dedicated agent for heartbeats if it
  needs other limits).
- A wake while approvals are pending waits for `respond()`; a heartbeat never denies them.

Runnable: [`examples/background-events.ts`](../../examples/background-events.ts).

## Skills from a database

Skills that admins edit in your product live in your database. A custom `SkillSource` lists them
(metadata only), loads one body on demand, and may carry a `version` (0.4.0) that the model sees in
`load_skill` and hooks receive — so you can audit which version a turn used:

```ts
import { defineHarnessAgent, definePlugin, defineSkillSource } from 'eharness'

const dbSkills = defineSkillSource({
  id: 'db:skills',
  refresh: 'turn', // re-list every turn: edits apply without restarting sessions
  async list(ctx) {
    const rows = await db.skills.list(String(ctx.runtime.tenantId))
    return rows.map((r) => ({ name: r.name, description: r.description, version: r.version }))
  },
  async load(name, ctx) {
    const row = await db.skills.get(String(ctx.runtime.tenantId), name)
    if (row === null) return null
    const manifest = row.files.map((f) => ({ path: f.path, size: f.text.length }))
    return { name: row.name, description: row.description, version: row.version, content: row.body, manifest }
  },
  async readFile(name, path, ctx) {
    const row = await db.skills.get(String(ctx.runtime.tenantId), name)
    const file = row?.files.find((f) => f.path === path)
    return file === undefined ? null : { type: 'text', text: file.text }
  },
})

const skillAudit = definePlugin({
  name: 'skill-audit',
  setup: () => ({
    hooks: {
      'skill.load': (ctx, e) => {
        ctx.log.info('skill loaded', { skill: e.skill.name, version: e.version, turn: ctx.turn?.id })
      },
    },
  }),
})

const agent = defineHarnessAgent({ model, skills: [dbSkills], plugins: [skillAudit] })
```

The skills index never shows versions, so bumping a version does not change the cached prompt;
with `refresh: 'turn'`, adding or renaming a skill changes the index (block 2) once. Test the
source with `skillSourceConformance`. Guide: [skills](skills.md#your-own-source-database-api-per-tenant).
Contract: spec 07 §3.

## Pipeline workers and tool-heavy agents

**Structured output (0.4.0).** An agent used as a pipeline step needs a typed result, not free
text. `session.send(input, { output: { schema } })` adds a `final_answer` tool for the turn (or
passes AI SDK `Output.object` with `mode: 'native'`), sends validation errors back to the model
up to `maxRetries` times (default 2) and returns the valid answer typed in `result.output`; a turn
without one stops `'output-invalid'` (`W_OUTPUT_INVALID`):

```ts
const { stop, output } = await session.send(ticket, { output: { schema: triage } }).result
if (stop === 'complete') await queue.push(output)
```

Guide: [structured output](structured-output.md). Contract: spec 05 §3.3, ADR-0023.

**Prune for tool-heavy agents (0.4.0).** Agents that read files, search or call APIs fill their
context with old tool outputs. Pruning replaces large outputs of older turns by a short
placeholder in the request only — cheaper than summarizing, storage untouched:

```ts
import { defineHarnessAgent } from 'eharness'

const agent = defineHarnessAgent({
  model,
  compaction: { prune: { keepTurns: 2, minChars: 2_000, exclude: ['todo_write'] } },
})
```

The summarizer runs only if the pruned context is still too large; the cached prefix changes once
per turn, never within one. A turn whose context fills up again right after a compaction stops
with `'context-thrash'` instead of summarizing in a loop. Guide:
[compaction](compaction.md#pruning-old-tool-outputs).

## Security

eharness enforces what it can see — message shapes, tool approvals, path rules — and leaves
identity and authorization to the application. The risks below are design-level: each lists the
risk, what eharness does by default, and what your application must do.

### Session ownership

- **Risk:** eharness knows only `sessionId`. Anyone who can call your route with another user's
  session id can read its running turn (`attach()` replays the whole turn), send into it, answer
  its approvals or inject events.
- **Default:** no check (there is no user concept in the library).
- **Do:** authenticate every route and check that the caller owns the session **before**
  `agent.session(id)` — the POST route, the resume **GET** route (`attach()`), routes that call
  `respond()`, `inject()`, `messages()` or `stats()`. Use unguessable session ids as defence in
  depth, not as the check.

```ts
// GET /api/chat/[id]/stream — useChat({ resume: true })
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await authenticate(req)
  if (!(await userOwnsChat(user.id, id))) return new Response(null, { status: 404 })
  const run = agent.session(id).attach()
  return run ? run.toResponse() : new Response(null, { status: 204 })
}
```

### `runtime` is shared by a live session

- **Risk:** `agent.session(id, { runtime })` returns the **cached** live session; its `runtime` is
  replaced by the latest call (spec 05 §1). Two requests for the same session (two tabs, two
  members of a group chat) see each other's session-level runtime, and session-refresh
  instructions and per-session resolvers (`filesystem({ fs: (ctx) => … })`) keep the values of
  the request that opened the session.
- **Default:** session-level runtime, last writer wins.
- **Do:** pass per-request identity in `SendOptions.runtime` (`send(…, { runtime })`,
  `handleChatRequest(…, { runtime })`), merged over the session runtime for that turn only. Never
  authorize from `ctx.runtime` set at session level; derive per-session resources (the session's
  file system, memory roots) from data that is fixed for the session (its owner in your database).

### Budgets are per turn and per session

- **Risk:** `budget.maxTurnUsd` / `maxSessionUsd` cap one turn and one session. A user with many
  sessions, or a script that creates sessions, is not capped.
- **Default:** no budget at all unless configured.
- **Do:** enforce per-user and per-tenant quotas in your application (read `TurnResult.usage.costUsd`
  or `state.core.usage` after every turn, refuse new turns over quota), or let a
  [`budget.ledger`](#cross-session-budgets) (0.5.0) enforce per-user and per-tenant scopes inside
  the loop. Keep a turn budget for unattended work (heartbeats, wake turns).

### Path rules are exact prefixes

- **Risk:** `readonlyPrefixes` and `hiddenPrefixes` (and memory roots) compare **normalized**
  paths with directory semantics (`'/skills'` covers `/skills/**`, not `/skillsx`). They know
  nothing about your backend: on a case-insensitive store `/Skills/x` is not under `/skills`, and a
  symlink can point a visible path at a hidden one.
- **Default:** exact, case-sensitive prefix match after `normalizePath`.
- **Do:** make your `FileSystem` adapter canonical: lower-case keys (or reject case variants) on
  case-insensitive stores, never follow symlinks out of the adapter's root, and keep secrets out of
  any file system the model can reach.

### Evicted tool outputs share the session's file system

- **Risk:** `toolOutput.strategy: 'evict'` writes full tool outputs to the `toolOutputs` service,
  i.e. the session's `fs` (`/.eharness/tool-outputs/<toolCallId>.txt`). If your `fs` resolver
  returns a file system shared by several sessions or users, one session can read another's
  outputs with `read_file`.
- **Default:** evicted outputs are read-only for the model but readable by any session on the same
  `fs`; they are never cleaned up.
- **Do:** resolve one `fs` per session or per user (`filesystem({ fs: (ctx) => … })`), or use
  `filesystem({ toolOutputs: false })` with `strategy: 'truncate'`; delete old outputs yourself.

### Agent-written skills

- **Risk:** `filesystem({ skills: { root, hideSkillsRoot: false } })` lets the model write and edit
  `SKILL.md` files. A prompt injection in one session (a web page, an email) can plant
  instructions that every **future** session loads as a skill.
- **Default:** `hideSkillsRoot: true` — the skills root is invisible to the file tools.
- **Do:** keep the default unless agent-authored skills are a feature; then add
  `readonlyPrefixes` for vetted skills, review new or changed skills before they are listed (e.g.
  a separate draft root), and record versions (`SkillMeta.version`, `skill.load`).

### Session-wide approval grants

- **Risk:** `respond({ approvals: [{ …, remember: 'session' }] })` grants the **whole tool** for
  the rest of the session, whatever its input.
- **Default:** `remember: 'once'`.
- **Do:** offer "remember" only for low-risk tools; use `'once'` for destructive ones (risk
  `'destructive'`, spec 11 §3.2); call `session.clearGrants()` when the user's privileges change
  or another person takes over the session. A standing grant also answers
  [guard](#guard-in-production) escalations (never a guard denial).

### Logs and error texts

- **Risk:** errors carry secrets: a database driver error with a connection string, a provider
  error with an API URL and key. The default logger writes warnings and errors to the console, and
  a thrown tool error becomes the tool result the UI, storage and model see.
- **Default:** `String(error)` for tool errors; provider errors are described from AI SDK
  `APICallError` / `StreamProviderError` only, with URLs, query strings and key-like tokens
  redacted and capped at 300 characters (0.4.0); other errors with a status read `HTTP <status>`.
- **Do:** set `logger` (structured, scrubbed) and `onWarning`; set `toolErrorText` to map thrown
  tool errors to safe text (0.4.0). Treat the redaction as defence in depth, not a filter you rely
  on.

```ts
import { defineHarnessAgent } from 'eharness'

const agent = defineHarnessAgent({
  model,
  logger: myScrubbingLogger,
  toolErrorText: (error, { toolName }) =>
    error instanceof MyDomainError ? error.publicMessage : `Error: ${toolName} failed.`,
})
```

### URLs fetched by the provider

- **Risk:** a user `file` part with a URL is downloaded by AI SDK or the provider. A URL to an
  internal address is an SSRF vector; an expired URL used to break every later turn.
- **Default (0.4.0):** `inputFiles: { protocols: ['data:', 'https:'], maxBytes: 20 MB }` — other
  protocols and larger `data:` URLs are `EH_INVALID_INPUT`; a file of an earlier turn that can no
  longer be downloaded is replaced by `FILE_UNAVAILABLE` on the wire.
- **Do:** in SSRF-sensitive deployments allow only `data:` (`inputFiles: { protocols: ['data:'] }`)
  or upload files to your own object store first and pass its URLs; never pass `http:` unless the
  store is yours.

### What the core already guarantees

- Client messages are untrusted: only `text` and `file` parts are accepted; tool parts, data parts
  and kinds are rejected; ids are server-generated; `metadata.eharness` is rebuilt; other client
  metadata is dropped unless `acceptClientMetadata` (spec 05 §3 step 7).
- Pending approval ids are server-owned and consumed atomically before a continuation runs:
  replayed or stale answers never execute tools (spec 11 §8). Exactly-once across instances needs a
  `SessionLock` or `StateAdapter.setIf`. `approval.secret` adds HMAC signatures when storage is
  shared or exposed.
- The approver's identity and authorization are yours: check them before `respond()` and pass
  `actor` for the audit trail (`approval.decided`).
- `grep` accepts only a conservative safe subset of regular expressions (no catastrophic
  backtracking); file tools enforce read-only,
  hidden and undeletable rules; memory tools reject paths outside the resolved roots.
- Nothing is persisted before the commit point of a turn: a failed lock or a rejected input leaves
  storage untouched.
