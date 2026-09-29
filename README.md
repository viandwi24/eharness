# eharness

> Build your own agent harness on the [Vercel AI SDK](https://ai-sdk.dev) v7 — plugins, context,
> messages, streaming, sessions and compaction, with storage you plug in.

**Status: pre-release (0.0.x). The API described in [`docs/specs`](docs/specs) is being
implemented; do not use in production yet.**

```ts
import { defineHarnessAgent, defineSkill, handleChatRequest } from 'eharness'
import { filesystem } from 'eharness/filesystem'
import { memoryFs } from 'eharness/filesystem/memory'

const agent = defineHarnessAgent({
  model: 'anthropic/claude-sonnet-4.6',
  contextWindow: 200_000,
  instructions: 'You are a careful coding assistant.',
  skills: [defineSkill({ name: 'style-guide', description: 'House style. Use before writing code.', content: '…' })],
  plugins: [filesystem({ fs: memoryFs(), skills: { root: '/skills' } })],
  approval: { policy: { delete_file: 'user-approval' } },   // human-in-the-loop via useChat
})

// Next.js / any Fetch-style route — works with useChat's default request body
export async function POST(req: Request) {
  const body = await req.json()
  // send, approval answers, regenerate and edit — all as one AI SDK UI message stream
  return handleChatRequest(agent.session(body.id), body).toResponse()
}
```

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

## Install

```bash
bun add eharness ai zod        # or npm / pnpm
bun add @ai-sdk/mcp            # only if you use eharness/mcp
```

Requires Node ≥ 22 or Bun. ESM only.

| eharness | ai |
|---|---|
| 0.x | ^7 |

## Documentation

- [Concept](docs/concept.md) · [Architecture](docs/architecture.md) · [Specs](docs/specs)
- [Decisions (ADRs)](docs/decisions) · [Contributing](CONTRIBUTING.md)

## License

MIT (pending confirmation).
