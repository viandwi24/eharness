# eharness

> Build your own agent harness on the [Vercel AI SDK](https://ai-sdk.dev) v7 — plugins, context,
> messages, streaming, sessions and compaction, with storage you plug in.

[![CI](https://github.com/viandwi24/eharness/actions/workflows/ci.yml/badge.svg)](https://github.com/viandwi24/eharness/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/eharness)](https://www.npmjs.com/package/eharness)

**Status: 0.1 — first public release.** The contracts in [`docs/specs`](docs/specs) are implemented
and tested. Before 1.0, breaking changes ship only in minor versions (`0.1 → 0.2`) with a
migration note, so `^0.1.0` is safe to depend on ([API stability](docs/engineering/api-stability.md)).

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
  const body = await req.json() // useChat's { id, messages, trigger, messageId }
  // send, approval answers, regenerate and edit — one AI SDK UI message stream
  return handleChatRequest(agent.session(body.id), body).toResponse()
}
```

On the client: `useChat<InferHarnessUIMessage<typeof agent>>()` — every data part, tool and
message kind is typed. Full route + client: [`examples/next-route.ts`](examples/next-route.ts).

### Tools that use the running chat and stream custom UI data

Write a tool as a function `(ctx) => tool()` to get the session context, and declare `dataParts`
to stream your own typed UI data from inside the tool:

```ts
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
| `ctx.turn` | this turn's user message (`input`), model, `abortSignal`, `addUsage()` |
| `ctx.runtime` | your app values (user, tenant, request) from `agent.session(id, { runtime })` and `send(…, { runtime })` |
| `ctx.state` | JSON state stored with the session |
| `ctx.services` | services from plugins, e.g. `ctx.services.fs` |
| `ctx.stream.data(name, data, { id })` | write a declared data part (type-checked); `ctx.stream.write(chunk)` for any registered part |
| 2nd `execute` argument (AI SDK) | `toolCallId`, `messages` (model messages so far), `abortSignal` |

The client sees `data-invoice` in `message.parts` (typed) and transient parts in
`useChat({ onData })`. Runnable: [`examples/tool-context.ts`](examples/tool-context.ts); more in
[rendering data parts](docs/guides/rendering-data-parts.md).

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
- **Long-running and interactive:** tool approvals, client-side tools, regenerate/edit, steering
  while the agent works, background wake-ups, crash recovery, prompt-cache-friendly layout.

## Entry points

| Import | Contents |
|---|---|
| `eharness` | `defineHarnessAgent`, `definePlugin`, `defineSkill`, `defineToolSource`, `defineDataPart`, `defineMessageKind`, `handleChatRequest`, types |
| `eharness/filesystem` | `FileSystem` contract, `filesystem()` plugin (file tools, skills autoload), helpers |
| `eharness/filesystem/memory` | `memoryFs()` |
| `eharness/storage/memory` | `memoryMessages()`, `memoryState()` (the default storage) |
| `eharness/mcp` | `mcpServer()` tool source (optional peer `@ai-sdk/mcp`) |
| `eharness/testing` | `scriptedModel()` and conformance suites for your adapters |

## Examples

Every example runs offline (`bun examples/<file>`) and is typechecked and executed in CI.

| Example | Shows |
|---|---|
| [`quick-start.ts`](examples/quick-start.ts) | the code above |
| [`tool-context.ts`](examples/tool-context.ts) | a tool that reads the running chat and streams custom data parts |
| [`basic-cli.ts`](examples/basic-cli.ts) | terminal rendering with `readUIMessageStream`, filesystem plugin |
| [`next-route.ts`](examples/next-route.ts) · [`.demo.ts`](examples/next-route.demo.ts) | Next.js routes, `useChat` client, approvals, resume |
| [`plugin-authoring.ts`](examples/plugin-authoring.ts) | a plugin with a service, tool, data part, hooks and state |
| [`subagent-tool.ts`](examples/subagent-tool.ts) | a tool that runs a child session, streams its progress, reports usage |
| [`json-file-storage.ts`](examples/json-file-storage.ts) | `MessageAdapter` + `StateAdapter` on JSON files |
| [`postgres-storage.ts`](examples/postgres-storage.ts) | Postgres adapters + advisory-lock `SessionLock` |
| [`custom-fs-adapter.ts`](examples/custom-fs-adapter.ts) | a `FileSystem` over a key-value store |

## Guides

[Getting started](docs/guides/getting-started.md) ·
[Writing a plugin](docs/guides/writing-a-plugin.md) ·
[Writing a storage adapter](docs/guides/writing-a-storage-adapter.md) ·
[Rendering data parts](docs/guides/rendering-data-parts.md) ·
[Skills](docs/guides/skills.md) ·
[Approvals and interaction](docs/guides/approvals-and-interaction.md) ·
[Subagents](docs/guides/subagents.md)

Reference: [concept](docs/concept.md) · [architecture](docs/architecture.md) ·
[specs](docs/specs) (the contracts) · [decisions (ADRs)](docs/decisions) ·
[contributing](CONTRIBUTING.md)

## Compatibility

| eharness | ai | zod | @ai-sdk/mcp (optional) | Runtime |
|---|---|---|---|---|
| 0.1.x | ^7 | ^3.25.76 \|\| ^4.1.8 | ^2 | Node ≥ 22, Bun |

A new AI SDK major needs a new eharness minor (0.x) / major (≥ 1.0).

## License

[MIT](LICENSE)
