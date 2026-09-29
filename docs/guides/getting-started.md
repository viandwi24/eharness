# Getting started

From an empty directory to a running agent. Requires Node ≥ 22 or Bun.

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

What you declared:

- **`model`** — a gateway string (needs `AI_GATEWAY_API_KEY`) or a provider model such as
  `anthropic('claude-sonnet-4-6')` from `@ai-sdk/anthropic`.
- **`contextWindow`** — used by compaction and the context guard. Set it; the default (128k)
  warns once.
- **`tools`** — plain AI SDK tools. **`skills`** — playbooks the model opens on demand
  ([skills guide](skills.md)). **`plugins`** — here the reference `filesystem()` plugin with an
  in-memory file system: the model gets `read_file`, `write_file`, `edit_file`, … tools.

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

## 5. Next steps

- **Keep history across restarts:** pass `storage: { messages, state }`. The default is in memory;
  see [writing a storage adapter](writing-a-storage-adapter.md) and the JSON-file and Postgres
  examples.
- **Serve a web UI:** `handleChatRequest(agent.session(body.id), body).toResponse()` speaks
  `useChat`'s protocol — [`examples/next-route.ts`](../../examples/next-route.ts).
- **Stop reasons and errors:** `run.result` resolves with `stop` (`complete`, `tool-pending`,
  `error`, `aborted`, `max-steps`, …) and `error: { code, message }`. Only `EH_SESSION_BUSY` and
  `EH_SESSION_CLOSED` are thrown by `send()`. Call `await session.ready()` first if you want
  configuration errors as exceptions.
- **Shut down:** `await agent.close()` closes sessions (MCP clients, plugin resources).
