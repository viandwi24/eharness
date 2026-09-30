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

## What is stored

The summary is an ordinary message: an `eh.compaction` kind message with one
`data-eh.compaction` part `{ summary, resumeFromId, partial?, tokens: { before, after }, trigger,
model? }`. Nothing is deleted or rewritten, so your UI can still show the whole history (render the
marker as a divider), and a cold load needs one query (`load({ fromId })` from the marker). Live
UIs get `data-eh.status { state: 'compacting' }` while it runs.

Plugins can take part: `compaction.prompt` hooks add context to the summarizer prompt (the todos
plugin adds the open list) and `compaction.after` hooks see the new marker.

## Watching the context size

```ts
const stats = await session.stats()
console.log(`${stats.tokens} / ${stats.window} tokens; summarize at ${stats.summarizeAt}`)
console.log(stats.lastCompaction, stats.pending, stats.activeTurn)
```

`ContextStats` has `window`, `tokens` (calibrated estimate of the next request), `instructions`,
`tools`, `messages`, `summarizeAt`, `hardLimit` (absolute tokens) and `lastCompaction`. The same
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
