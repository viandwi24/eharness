# Instructions, tools and MCP

What the model can read and call in a turn: instructions, tools (static, per session, or listed at
runtime), MCP servers, and the limits around tool results. Every slot takes a constant or a
runtime loader; the model cannot tell them apart. Contracts: spec 02 (registry, prompt layout),
spec 09 (tools and MCP).

## Instructions

```ts
import { defineHarnessAgent } from 'eharness'

const agent = defineHarnessAgent({
  model,
  instructions: [
    'You are the support agent of Acme.', // static
    // a function: evaluated at the first turn of the session, then cached ('session')
    async (ctx) => `The customer's plan is ${String(ctx.runtime.plan)}.`,
    // refreshed every turn: sent as a turn reminder, not in the system prompt
    { text: () => `Current time: ${new Date().toISOString()}`, refresh: 'turn', id: 'clock' },
  ],
})
```

Static and session instructions form two stable system blocks, so providers can cache the prompt
prefix. Anything that changes every turn goes into a `refresh: 'turn'` instruction (a turn
reminder), and anything that changes every step into a `step.prepare` hook's `reminder`. Both are
sent as `<system-reminder>` user messages, never stored and never shown in the UI. An instruction
function that throws fails the turn before anything is saved.

## Tools

Tools are plain AI SDK tools. A function `(ctx) => tool()` is resolved once per session with the
session context ([getting started](getting-started.md#5-tools-that-use-the-running-chat)):

```ts
import { tool } from 'ai'
import { defineHarnessAgent, defineToolSource } from 'eharness'
import { z } from 'zod/v4'

const agent = defineHarnessAgent({
  model,
  tools: [
    {
      get_price: tool({
        description: 'Price of a product',
        inputSchema: z.object({ sku: z.string() }),
        execute: async ({ sku }) => (sku === 'A1' ? '12.00 EUR' : `ERROR: unknown sku ${sku}`),
      }),
    },
    // listed at runtime: per user, per tenant, from a database
    defineToolSource({
      id: 'tenant-actions',
      refresh: 'turn', // default 'session': listed once, at the first turn of the session
      list: async (ctx) => ({
        [`notify_${String(ctx.runtime.tenant)}`]: tool({
          description: 'Notify the tenant team',
          inputSchema: z.object({ text: z.string() }),
          execute: async ({ text }) => `Sent: ${text}`,
        }),
      }),
    }),
  ],
})
```

- Return **error strings** for expected failures (`ERROR: …`); the model reads them and corrects
  itself. A thrown error becomes a tool error result with the same text (`HarnessToolError`).
- **A thrown error's text reaches the client and the model verbatim** (`String(error)`: UI stream,
  stored message and model wire). Driver and HTTP errors often carry secrets — connection strings
  (`postgres://user:password@…`), signed URLs, tokens. Map them with `toolErrorText`:

  ```ts
  defineHarnessAgent({
    model,
    toolErrorText: (error, { toolName }) => {
      console.error(`tool ${toolName} failed`, error) // keep the details in your logs
      return `Error: ${toolName} failed; try again later.`
    },
  })
  ```

  The mapped text is used everywhere (UI, storage and wire stay identical). If the mapper throws
  or returns no string, the text is `Error: the tool failed.`
- Static names must be unique (`EH_DUPLICATE_TOOL`: at boot for config / `setup()` tools, at
  session open for a plugin's `session()` tools). A source that returns a name that is
  already taken is skipped with `W_SHADOWED`; a failing `list()` contributes nothing for that turn
  (`W_TOOL_SOURCE_FAILED`) and is retried next turn.
- The tool set is fixed for a turn and keeps a stable order (static, skill tools, sources,
  `tool_search`) for the prompt cache. Restricting tools per step (`activeTools`) busts the cache
  (`W_CACHE_BUST`); prefer `toolChoice` or a `tool.approve` denial.
- Reserved names: `tool_search`, `load_skill`, `read_skill_file`, `search_skills`.
- Tools without `execute` are client-side tools; tools with `metadata: { risk }` feed risk-based
  approvals ([approvals and interaction](approvals-and-interaction.md)).

### Deferred tools and tool search

With many tools, send only a few up front: a source with `defer: true` (or any tool with
`deferLoading: true`) is hidden until the model finds it with the `tool_search` tool that the core
adds automatically. Discovered tools are callable from the next step for the rest of the turn, and
discoveries survive reloads (they are read back from stored `tool_search` results).

```ts
import { defineToolSource } from 'eharness'

const catalog = defineToolSource({
  id: 'catalog',
  defer: true,
  list: async () => ({}), // e.g. hundreds of generated API tools
})
```

Each discovery changes the provider-visible tool list, so it costs one prompt-cache miss.

## MCP servers (`eharness/mcp`)

`mcpServer()` turns an MCP server into a tool source over `@ai-sdk/mcp` (an optional peer
dependency: `npm install @ai-sdk/mcp`).

```ts
import { defineHarnessAgent } from 'eharness'
import { mcpServer } from 'eharness/mcp'

const agent = defineHarnessAgent({
  model,
  mcp: [
    mcpServer({
      name: 'github', // tools become github_<tool>; source id 'mcp:github'
      // a config, or a resolver per session (per-user credentials)
      transport: (ctx) => ({
        type: 'http',
        url: 'https://mcp.example.com/github',
        headers: { authorization: `Bearer ${String(ctx.runtime.githubToken)}` },
      }),
      allow: ['search_issues', 'create_issue'], // or deny: [...]; server names, before the prefix
      defer: 'auto', // default: deferred when more than 20 tools remain (MCP_AUTO_DEFER_THRESHOLD)
      connect: 'lazy', // default: connect at the first turn; 'eager': at session open
      pinDefinitions: true, // exclude tools whose definition changed since the first connect
    }),
  ],
})
```

- One MCP client **per session** (credentials can differ per user), closed when the session closes.
  A resolver must return a new transport per call; an `MCPTransport` instance as `transport` is
  rejected (`EH_CONFIG_INVALID`).
- Connection or listing failures give zero tools and `W_TOOL_SOURCE_FAILED`; the next turn retries.
  Importing `eharness/mcp` never fails without `@ai-sdk/mcp`; connecting does.
- `pinDefinitions` stores a fingerprint of every server tool in the session state; changed or new
  tools are excluded with `W_MCP_DRIFT` until you re-pin with
  `clearMcpPins(agent, sessionId, 'github')` (use one `mcpServer()` instance per agent).
- Tools annotated `destructiveHint` count as risk `'destructive'` for `approval.risk`;
  `readOnlyHint` is ignored (annotations are hints from the server, not guarantees).
- `mcp: [...]` is the same as putting the sources into `tools`; it exists for readability.
- Other options: `prefix` (default `<name>_`, `''` for none), `maxRetries` (retries of tool calls,
  default 0), `refresh` (`'session'` or `'turn'`).

## Tool output limits

Large tool results are the main cause of context blow-ups. Every final tool output is limited
before it reaches the model, the stream and storage:

```ts
import { defineHarnessAgent } from 'eharness'
import { filesystem } from 'eharness/filesystem'
import { memoryFs } from 'eharness/filesystem/memory'

defineHarnessAgent({
  model,
  toolOutput: {
    maxChars: 50_000, // default, per result (JSON length for structured outputs)
    perTool: { read_logs: 200_000, get_price: false }, // false = unlimited
    strategy: 'evict', // default 'truncate'
  },
  plugins: [filesystem({ fs: memoryFs() })], // provides the toolOutputs service `evict` needs
})
```

- `truncate` keeps the head (70%) and tail (30%) around `TOOL_OUTPUT_TRUNCATED`
  (`…[truncated N chars]…`); structured outputs become `{ truncated: true, preview, originalChars }`.
- `evict` saves the full output to `/.eharness/tool-outputs/<toolCallId>.txt` (the filesystem
  plugin's `toolOutputs` service) and tells the model to page through it with `read_file`. Without
  the service it falls back to `truncate`.
- Every limited result raises `W_TOOL_OUTPUT_LIMITED`. `tool.after` hooks run before the limit;
  preliminary outputs (async generator tools) are never limited.

## Timeouts, retries and repair

```ts
import { defineHarnessAgent } from 'eharness'

defineHarnessAgent({
  model,
  settings: {
    maxRetries: 3, // provider request retries (AI SDK)
    streamRetries: 1, // retry a step after streaming started
    timeout: { stepMs: 120_000, chunkMs: 30_000, toolMs: 60_000 }, // per step; a number = stepMs
  },
  loop: { turnTimeoutMs: 20 * 60_000 }, // the whole turn → stop 'timeout'
  repairToolCall: async ({ toolCall }) => null, // AI SDK repairToolCall; null = keep the error
})
```

A timed-out tool becomes a tool error the model can read; a step timeout ends the turn with
`'timeout'`. `settings.timeout.totalMs` is rejected — use `loop.turnTimeoutMs`.

## Choosing the model per turn or step

```ts
import { defineHarnessAgent, definePlugin } from 'eharness'
import { z } from 'zod/v4'

const agent = defineHarnessAgent({
  model: 'anthropic/claude-sonnet-4.6',
  // typed per-call options: send(…, { options }) is validated (EH_INVALID_INPUT) → ctx.turn.options
  callOptions: z.object({ effort: z.enum(['low', 'high']) }),
  plugins: [
    definePlugin({
      name: 'router',
      setup: () => ({
        hooks: {
          'turn.prepare': (ctx, e) =>
            (e.options as { effort?: string } | undefined)?.effort === 'low'
              ? { model: 'anthropic/claude-haiku-4.5', settings: { temperature: 0 } }
              : undefined,
        },
      }),
    }),
  ],
})

const session = agent.session('s1')
await session.send('Quick question', { options: { effort: 'low' } }).result
await session.send('Hard question', { model: 'anthropic/claude-opus-4.1', maxSteps: 50 }).result
```

`SendOptions` (`send`, `respond`, `regenerate`, `edit`) also take `settings`, `abortSignal`,
`runtime` (merged over the session's `runtime`) and `toolsContext` (AI SDK per-tool context,
validated against each tool's `contextSchema`). A `step.prepare` hook can switch the model or
settings for one step, set `toolChoice`, add a `reminder`, or rewrite the wire for that step only.
The context window and prices follow the model actually used ([models and cost](models-and-cost.md)).
