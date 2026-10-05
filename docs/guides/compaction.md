# Context and compaction

Long conversations outgrow the context window. eharness keeps every message in storage and sends
the model a **view**: a summary of older turns, the recent turns verbatim, and the current turn.
The algorithm is fixed and tested (ADR-0004); you tune a few knobs. Contract: spec 06.

## Configuration

```ts
import { defineHarnessAgent } from 'eharness'

const agent = defineHarnessAgent({
  model: 'anthropic/claude-sonnet-4.6',
  contextWindow: 200_000, // or a function of the model, or from `models` (models-and-cost guide)
  compaction: {
    summarizeAt: 0.75, // default — summarize when the next request would exceed 75% of the window
    keepLast: 4, // default — completed turns kept verbatim (shrinks automatically if needed)
    model: 'anthropic/claude-haiku-4.5', // default: the agent model; a cheaper one is fine
    maxSummaryTokens: 4_000, // default
    // prompt: '…',                      // replace the summarizer instructions
    // countTokens: (text) => …,          // default ceil(chars / 4), calibrated by provider usage
    // select: (view, ctx) => view,       // escape hatch: final say over the view, before the guard
    // prune: {},                         // off by default — prune old tool outputs first (below)
    // thrash: { withinSteps: 2 },        // default — stop a turn that refills right after compacting
  },
  guard: { maxContextRatio: 0.9 }, // default; reserveTokens: settings.maxOutputTokens ?? 8% of the window
})
```

`compaction: false` turns summarization off; the guard and overflow recovery below still run.

## When it runs

| Trigger | When | Marker `trigger` |
|---|---|---|
| Pre-turn | at the start of a turn, after the new user message is saved | `'turn'` |
| Mid-turn | before a step of a long turn (older steps of the running turn are summarized) | `'auto'` |
| Manual | `await session.compact()` while idle; resolves the marker, or `null` when skipped | `'manual'` |

Compaction is skipped when there is nothing new to summarize or when summarizing would not get
below `summarizeAt`; the guard handles the size then. A failed automatic compaction raises
`W_COMPACTION_FAILED` and the turn continues with the guard.

## Pruning old tool outputs

Tool-heavy agents (file reads, search results, logs) fill the window with outputs that matter for
a few turns. `compaction.prune` replaces them by a short placeholder **in the request only** —
before the summarizer is considered:

```ts
compaction: {
  prune: {
    keepTurns: 2, // default — the newest completed turns keep their outputs (the current turn always does)
    minChars: 2_000, // default — only larger outputs are pruned
    exclude: ['read_file'], // tools whose outputs are never pruned
    // replaceWith: (part) => `[${part.toolName} output elided]`, // pure; default TOOL_OUTPUT_PRUNED
  },
}
```

- An old output becomes `[output of read_file pruned: 18342 chars]`; the tool call (name, input)
  and its result stay paired, so the model knows what it ran and can run it again. Errors and
  denials are never pruned.
- Stored messages never change: your UI and `session.messages()` still show every output, and the
  summarizer still sees the originals (capped at 2 000 characters).
- Order: prune → re-measure → summarize only if the context is still above `summarizeAt`.
  `ContextStats.messages` reflects the pruned request; `ContextStats.pruned` says how many outputs
  were replaced and how many characters that saved.
- **Prompt cache trade-off:** the request is rebuilt at the start of each turn. When a turn ages
  past `keepTurns`, the cached prefix breaks once, at its first pruned output; inside a turn the
  prefix is stable. A larger `keepTurns` breaks the cache later but keeps more tokens. For most
  tool-heavy agents one partial cache miss per turn is much cheaper than a summarizer call.

Runnable: [`examples/context-prune.ts`](../../examples/context-prune.ts).

## When a turn thrashes

If a turn fills the context again right after a compaction (a step that reads huge outputs),
compacting again would only burn money. By default, when a second compaction within 2 model
steps of the previous mid-turn compaction cannot bring the context below `summarizeAt`, the turn
stops with `stop: 'context-thrash'`
(warning `W_CONTEXT_THRASH`, and an `eh.notice` with code `EH_CONTEXT_THRASH` is saved so the UI
can show why). Typical fixes: limit tool outputs (`toolOutput.maxChars`), page large reads, or a
model with a larger window. `compaction: { thrash: { withinSteps: 3 } }` widens the window;
`thrash: false` restores 0.3 behaviour (keep going). A compaction at the start of a turn does not
count: one large tool output after it compacts normally.

## What is stored

The summary is an ordinary message: an `eh.compaction` kind message with one
`data-eh.compaction` part `{ summary, resumeFromId, partial?, tokens: { before, after }, trigger,
model? }`. Nothing is deleted or rewritten, so your UI can still show the whole history (render the
marker as a divider), and a cold load needs one query (`load({ fromId })` from the marker). Live
UIs get `data-eh.status { state: 'compacting' }` while it runs.

Plugins can take part: `compaction.before` hooks can request a flush (next section),
`compaction.prompt` hooks add context to the summarizer prompt (the todos plugin adds the open
list) and `compaction.after` hooks see the new marker.

## Saving facts before summarizing

A summary is lossy. Right before it is produced, a `compaction.before` hook can give the agent one
short, internal turn — a **flush** — to write down what must survive, typically into memory
files. The memory plugin does it for you:

```ts
memory({ roots, flushOnCompaction: true }) // or { prompt: 'Save open decisions and file names.' }
```

It offers `memory_view`, `memory_create`, `memory_str_replace` and `memory_insert` (never delete or
rename) and skips the flush when no root is writable. Any plugin can do the same with its own
tools:

```ts
definePlugin({
  name: 'facts',
  setup: () => ({
    tools: { save_fact: tool({ inputSchema: z.object({ fact: z.string() }), execute: saveFact }) },
    hooks: {
      'compaction.before': (ctx, e) => ({
        // e.messages: what will be summarized; e.tokens; e.trigger: 'turn' | 'auto' | 'manual' | 'overflow'
        flush: { prompt: 'Save every decision of this conversation with save_fact.', tools: ['save_fact'] },
      }),
    },
  }),
})
```

What happens:

- The flush runs only when the summary will really be written (after the skip rule, prune and the
  budget check), once per compaction, before the summarizer. Several plugins' requests merge into
  one flush (prompts joined, tools unioned, `maxSteps` = max, default 3).
- It is one `generateText` call over the **current conversation** plus your prompt, with only the
  listed tools (the turn's tools, so `tool.before`/`tool.after` and output limits apply). Tools
  that would ask the user for approval are denied automatically (`Not available during memory
  flush.`, visible in `approval.decided`).
- It leaves no trace in the conversation: later requests are the same as without a flush. The
  core stores one model-invisible `eh.flush` message (before the marker) with the trigger, the
  prompt, the tool names and statuses, usage and cost — no tool inputs or outputs. Render it as a
  small "memory saved" note, or ignore it.
- Its usage counts toward the turn (`TurnResult.usage`, cost, budgets; `source:
  'compaction-flush'`). A used-up budget skips the compaction and the flush.
- A failing flush is `W_HOOK_FAILED` (`details.phase: 'flush'`); the summary is written anyway. A
  flush that cannot fit the flush model's window is skipped (`W_COMPACTION_FLUSH_SKIPPED`); after
  a provider "too long" error it runs only with a `flush.model` that has a larger window.
- Use a cheaper model with `flush: { model }` (default: `compaction.model`, else the turn's model).

See `examples/compaction-flush.ts` for a runnable, offline version.

## Watching the context size

```ts
const stats = await session.stats()
console.log(`${stats.tokens} / ${stats.window} tokens; summarize at ${stats.summarizeAt}`)
console.log(stats.lastCompaction, stats.pending, stats.activeTurn)
```

`ContextStats` has `window`, `tokens` (calibrated estimate of the next request), `instructions`,
`tools`, `messages`, `summarizeAt`, `hardLimit` (absolute tokens), `lastCompaction` and, with
prune on, `pruned` (`{ outputs, chars }`). The same
object streams after every step as the transient `data-eh.context` part — a ready-made context
meter for the UI. Estimates are calibrated against the provider's reported input tokens.

## The guard

Before every step, whatever compaction did, the guard makes the request fit:

1. **Sanitize:** a tool call without a result gets the error result `INTERRUPTED_UNKNOWN` (never
   silently dropped), orphan results and empty messages are removed.
2. **Hard cap** at `window × maxContextRatio − reserveTokens`: drop the oldest completed turns from
   the request, then halve the largest tool outputs (`W_CONTEXT_TRUNCATED`); if it still does not
   fit, the turn ends with `stop: 'error'` and `EH_CONTEXT_OVERFLOW`.

The guard changes only what is sent, never what is stored.

## When the provider says "too long"

Token estimates can be wrong (images, tokenizers). When the provider rejects a request as too
long before streaming, the core recalibrates, compacts and retries once (`W_OVERFLOW_RETRY`), then
retries once more with a tighter guard, and only then ends the turn with `EH_CONTEXT_OVERFLOW`.
Common provider messages are recognised (also inside AI SDK retry errors); add your own with
`isContextOverflow: (error) => …` in the agent config.
