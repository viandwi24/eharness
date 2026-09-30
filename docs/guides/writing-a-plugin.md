# Writing a plugin

A plugin bundles capabilities — tools, skills, instructions, hooks, services, data parts and
message kinds — behind one `definePlugin()` call. The shipped `filesystem()` plugin is written with
exactly the public API described here (so is `todos()` from `eharness/todos` — use that one if
you need a checklist; the plugin below is a minimal teaching version). Full runnable version:
[`examples/plugin-authoring.ts`](../../examples/plugin-authoring.ts). Contract: spec 01.

## Anatomy

```ts
import { tool } from 'ai'
import { defineDataPart, definePlugin } from 'eharness'
import { z } from 'zod/v4'

export function checklist() {
  return definePlugin({
    name: 'checklist', // namespace: data part `data-checklist.list`, state `plugins.checklist.*`
    provides: ['checklist'], // services this plugin returns from session()
    dataParts: { list: defineDataPart({ schema: z.object({ items: z.array(z.string()) }) }) },

    // Agent phase: once, synchronous, no I/O. Static contributions are validated at boot.
    setup: () => ({ instructions: 'Keep a checklist with checklist_write for multi-step work.' }),

    // Session phase: once per live session, I/O allowed (connect clients, read config).
    session(ctx) {
      const items = () => ctx.state.get<string[]>('items') ?? []
      return {
        services: { checklist: { items } },
        tools: {
          checklist_write: tool({
            description: 'Replace the checklist.',
            inputSchema: z.object({ items: z.array(z.string()) }),
            execute: async ({ items: next }) => {
              ctx.state.set('items', next) // persisted with the session state
              ctx.stream.data('list', { items: next }, { id: 'checklist' }) // typed, namespaced
              return `Saved ${next.length} items.`
            },
          }),
        },
        hooks: {
          'step.prepare': () => ({ reminder: `Open items: ${items().length}` }),
        },
        dispose: () => {}, // close clients on session close / eviction
      }
    },
  })
}
```

Register it with `defineHarnessAgent({ model, plugins: [checklist()] })`. Plugins run in array order
(after the implicit root plugin `app` that holds the top-level config); that order is the order
of instructions and hooks.

## The context object

Hooks, `session()` and tool functions (`tools: { x: (ctx) => tool(…) }`, from `setup()` or
`session()`) receive `ctx` (`HarnessContext<DP>`, typed with this plugin's data parts), one per
session and plugin:

| Field | Use |
|---|---|
| `ctx.state` | `get` / `set` JSON values, namespaced per plugin, saved with the session |
| `ctx.stream.data(name, data, { id?, transient? })` | write this plugin's data parts; `name` and `data` are type-checked ([rendering guide](rendering-data-parts.md)) |
| `ctx.services` | typed services of all plugins (see below) |
| `ctx.turn` | the running turn: `id`, `kind`, `queued`, `input`, `options`, `model`, `settings`, `abortSignal`, `addUsage(usage, { model \| costUsd, source })` — `undefined` outside a turn |
| `ctx.step` | `{ index, model }` of the running step — `undefined` between steps |
| `ctx.runtime` | what the app passed as `SessionOptions.runtime` / `SendOptions.runtime` (user id, tenant, …) |
| `ctx.session`, `ctx.log`, `ctx.warn()`, `ctx.signal` | session id/parent, logger, warnings, session-close signal |

## Services

A service is a typed object shared between plugins without imports. Declare its type once with
declaration merging, provide it from exactly one plugin, and require it from others:

```ts
import { definePlugin } from 'eharness'

declare module 'eharness' {
  interface HarnessServices {
    checklist: { items(): string[] }
  }
}

const report = definePlugin({
  name: 'checklist-report',
  requires: ['checklist'], // boot error if missing, or if this plugin comes before the provider
  setup: () => ({
    hooks: { 'turn.end': (ctx) => console.log(ctx.services.checklist.items()) },
  }),
})
```

## Hooks

| Hook | Typical use |
|---|---|
| `input.submit` | validate, rewrite or block user input; add context |
| `turn.prepare` / `step.prepare` | pick model and settings, restrict active tools, add a volatile `reminder` |
| `tool.before` / `tool.after` | normalize input / transform output (chainable) |
| `tool.approve` | human-in-the-loop decisions, gets the tool's `risk` ([approvals guide](approvals-and-interaction.md)) |
| `approval.decided` | observe every approval decision (automatic and `respond()` answers with `actor`) for audit logs and inboxes |
| `step.end` | after each step: `usage`, `totalUsage`, `costUsd` (turn so far), `toolCalls`, `toolResults`, AI SDK's `step`; return `{ stop }` or `{ context }` |
| `turn.beforeEnd` | keep going (`{ continue: { reason } }` / `{ extendSteps }`) for `complete`, `max-steps`, `length`; the event has `continues` and `idleContinues` — the core refuses continuations after `loop.maxIdleContinues` idle ones ([long-running turns](long-running-turns.md)) |
| `turn.start` / `turn.end`, `session.start` / `session.close` | lifecycle side effects |
| `message.beforeSave`, `compaction.prompt`, `compaction.after`, `skill.load` | storage, compaction and skill integration |

Chainable hooks see the previous hook's result. A throwing hook is skipped with `W_HOOK_FAILED`,
except `tool.approve` and `input.submit`, which fail closed (denied / blocked).

## Rules that keep a plugin well-behaved

- **Tools return errors as strings** for expected failures (`ERROR: file not found`); the model
  reads them and corrects itself. Throw only for bugs.
- **`setup()` is pure.** No network, files or timers — do that in `session()`.
- **Volatile context goes into `step.prepare` reminders**, not into instructions: the system
  prompt stays byte-identical, so provider prompt caches keep hitting.
- **`tool.before` must be deterministic** and approval logic side-effect free: AI SDK re-runs
  them for approved calls.
- **State is small JSON** (guideline < 64 KB for the whole session); large data belongs in your
  own storage or a `FileSystem`.

## Testing a plugin

```ts
import { defineHarnessAgent } from 'eharness'
import { scriptedModel } from 'eharness/testing'

const model = scriptedModel([
  { toolCalls: [{ toolName: 'checklist_write', input: { items: ['outline'] } }] },
  { text: 'Planned.' },
])
const agent = defineHarnessAgent({ model, plugins: [checklist()] })
const result = await agent.session('t').send('Plan an article').result
// result.stop === 'complete'; model.prompts[1] is the wire of step 1 (incl. the reminder)
```
