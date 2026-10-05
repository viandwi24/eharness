# Rendering data parts

Custom UI data travels as AI SDK **data parts** (`{ type: 'data-<name>', id?, data }`) inside the
assistant message, in the same UI message stream `useChat` already reads. Contract: spec 03 §4–5,
spec 04.

## Choose the mechanism

| You want to show | Use |
|---|---|
| live progress, counters, spinners | **transient** data part (streamed, never stored) |
| something that must survive a reload (a file card, a report) | **persistent** data part, with an `id` to update it in place |
| message-level facts (model, usage, stop reason) | `message.metadata.eharness` (already there) |
| a message the model did not write (an event, a notice) | a **message kind** + `session.inject()` |

## Declare and write

```ts
import { tool } from 'ai'
import { defineDataPart, defineHarnessAgent } from 'eharness'
import { z } from 'zod/v4'

const agent = defineHarnessAgent({
  model,
  dataParts: {
    // app parts have no prefix: `data-invoice`; plugin parts are `data-<plugin>.<key>`
    invoice: defineDataPart({ schema: z.object({ total: z.number(), status: z.string() }) }),
    progress: defineDataPart({ schema: z.object({ percent: z.number() }), transient: true }),
  },
  tools: {
    create_invoice: (ctx) =>
      tool({
        inputSchema: z.object({ total: z.number() }),
        execute: async ({ total }) => {
          // names and payloads are type-checked against `dataParts`
          ctx.stream.data('progress', { percent: 50 }) // transient by definition
          // same id → the part is replaced in place (keeps its first position)
          ctx.stream.data('invoice', { total, status: 'draft' }, { id: 'inv-1' })
          ctx.stream.data('invoice', { total, status: 'sent' }, { id: 'inv-1' })
          return 'Invoice inv-1 sent.'
        },
      }),
  },
})
```

Tools a plugin contributes get the same typed `ctx.stream.data` for the plugin's own parts
([writing a plugin](writing-a-plugin.md)). `ctx.stream.write({ type: 'data-…', id?, data })` is
the untyped escape hatch for parts you do not own (any registered part except `data-eh.input`);
its argument type is `DataChunk` (AI SDK's `data-*` chunk: `{ type, id?, data, transient? }`).

Parts are validated against their schema when history is loaded and are hidden from the model
unless the definition sets `model: 'text'` or a projection function.

## Render

`InferHarnessUIMessage<typeof agent>` types every part — core, app, plugin parts and kinds:

<!-- docs-check: continue -->
```ts
import type { InferHarnessUIMessage } from 'eharness'

type ChatMessage = InferHarnessUIMessage<typeof agent>

function render(part: ChatMessage['parts'][number]): string | null {
  switch (part.type) {
    case 'text':
      return part.text
    case 'data-invoice':
      return `Invoice: ${part.data.total} (${part.data.status})`
    case 'data-eh.input': // a steer / event / hook note delivered inside this assistant message
      return `↳ ${part.data.text}`
    default:
      return null
  }
}
```

Transient parts never appear in `message.parts`; read them as they arrive:
`useChat<ChatMessage>({ onData: (part) => { if (part.type === 'data-progress') … } })`.
A terminal reads the chunks directly (`for await (const chunk of run.stream)`), see
[`examples/basic-cli.ts`](../../examples/basic-cli.ts).

## Core parts and kinds

| Type | Stored | Content |
|---|---|---|
| `data-eh.status` | no | `{ state: 'thinking' \| 'tool' \| 'compacting' \| 'idle', step?, tool? }` |
| `data-eh.usage` | no | `{ inputTokens, outputTokens, totalTokens, steps, costUsd? }` of the turn so far ([models and cost](models-and-cost.md)) |
| `data-eh.context` | no | context window stats after each step (a "context meter") |
| `data-eh.warning` | no | `{ code, message }` of non-fatal problems (`W_BUDGET`, `W_LOOP_STUCK`, …) |
| `data-eh.input` | yes | input delivered into a running turn (`source: 'user' \| 'event' \| 'plugin:<name>'`) |
| `eh.compaction` kind | yes | compaction marker with the summary |
| `eh.notice` kind | yes | errors, timeouts, recovered turns |
| `eh.event` kind | yes | `session.inject('eh.event', { name, text })` from your app |
| `eh.rewind` kind | yes | regenerate/edit marker (hidden from `session.messages()` views by default) |
| `eh.flush` kind | yes | audit record of a pre-compaction flush (never shown to the model); also streamed once as a transient `data-eh.flush` part ([compaction](compaction.md#saving-facts-before-summarizing)) |

Shipped plugins add their own parts (namespaced `data-<plugin>.<key>`, typed through
`InferHarnessUIMessage` as soon as the plugin is in `plugins`):

| Type | Stored | Content |
|---|---|---|
| `data-todos.list` | yes (id `list`) | `{ todos: Todo[] }` after every `todo_write` — [todos guide](todos.md), `latestTodos(messages)` |
| `data-filesystem.change` | yes (id = path) | `{ path, action: 'create' \| 'write' \| 'edit' \| 'delete', version, bytes? }`, latest change per file in a message (spec 08 §5) |

A kind message is an ordinary `UIMessage` with exactly one part `data-<kind>`, so the same
component renders it live and from history:

```ts
import { defineMessageKind } from 'eharness'
import { z } from 'zod/v4'

// defineHarnessAgent({ messageKinds: { deploy: … } }) → part type `data-deploy`
const deploy = defineMessageKind({
  role: 'user',
  schema: z.object({ version: z.string() }),
  model: (data) => `Deployed ${data.version}.`, // what the model sees; omit to hide it
})
// await agent.session(id).inject('deploy', { version: '1.4.0' })
```

## Outside a turn

`session.events()` is a long-lived `ReadableStream` of session events: `turn-start`, `turn-end`,
`pending`, `input-dropped`, injected `message`s, transient `data` written outside a turn, and
`status`. Use it for sidebars, notifications and "agent is working" indicators.
