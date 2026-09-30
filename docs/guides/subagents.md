# Subagents

A subagent is a second agent that a tool runs for one delegated task. eharness has no special
subagent runtime: the tool opens a **child session**, streams its progress into the parent
message as **preliminary tool results**, and reports the child's token usage to the parent turn
with **`ctx.turn.addUsage()`** so token caps and USD budgets count it. Runnable:
[`examples/subagent-tool.ts`](../../examples/subagent-tool.ts). A ready-made `subagent()` plugin
is on the [roadmap](../plans/roadmap.md).

```ts
import { type LanguageModelUsage, readUIMessageStream, tool } from 'ai'
import { defineHarnessAgent } from 'eharness'
import { z } from 'zod/v4'

const researcher = defineHarnessAgent({
  id: 'researcher',
  model,
  instructions: 'Research one question; answer with short findings.',
})

const agent = defineHarnessAgent({
  model,
  tools: {
    // A function receives the parent session's context (resolved once per session).
    research: (ctx) =>
      tool({
        description: 'Delegate one research question to a researcher subagent.',
        inputSchema: z.object({ question: z.string() }),
        async *execute({ question }, { toolCallId, abortSignal }) {
          const turn = ctx.turn
          if (turn === undefined) throw new Error('research runs only inside a turn')
          const child = researcher.session(`${ctx.session.id}:research:${toolCallId}`, {
            // recorded as ctx.session.parent in the child; depth > 8 is rejected
            parent: {
              sessionId: ctx.session.id,
              turnId: turn.id,
              toolCallId,
              depth: (ctx.session.parent?.depth ?? 0) + 1,
            },
          })
          const run = child.send(question, { abortSignal })
          let text = ''
          for await (const message of readUIMessageStream({ stream: run.stream })) {
            text = message.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
            yield { status: 'working', text } // preliminary: shown live, not sent to the model
          }
          const result = await run.result // never rejects
          // tokens + the child's estimated cost (set when `researcher` has `models` pricing)
          turn.addUsage(usage(result.usage), { costUsd: result.usage.costUsd, source: 'subagent:researcher' })
          yield { status: result.stop === 'complete' ? 'done' : 'failed', text } // final output
        },
      }),
  },
})

function usage(u: { inputTokens: number; outputTokens: number }): LanguageModelUsage {
  return {
    inputTokens: u.inputTokens,
    inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
    outputTokens: u.outputTokens,
    outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    totalTokens: u.inputTokens + u.outputTokens,
  }
}
```

How the pieces fit:

- **Preliminary results.** An `execute` that is an async generator yields preliminary outputs
  (`preliminary: true` on the UI part) and its **last** value is the final output — the only one
  the model sees, and the one `tool.after` hooks and output limits apply to.
- **Child session.** An ordinary session of any agent: its own history, storage and plugins. Give
  it a deterministic id (derived from the parent session and tool call) if you want to find it
  again, e.g. to show the full child transcript in the UI with `researcher.session(id).messages()`.
  `SessionOptions.parent` only records the link; it does not share history or state.
- **Usage, cost and limits.** `ctx.turn.addUsage(usage, options)` adds the child's tokens to the
  parent turn's `usage` and to `loop.maxTurnOutputTokens`, and its cost to `costUsd` and the
  parent's `budget` (both stop with `'cost-cap'`). The cost comes from `options.costUsd` (here the
  child's own estimate, [models and cost](models-and-cost.md)), else from `options.model` priced
  with the **parent's** `models`; without either the usage counts tokens only. `source` is a label
  for logs; a plain string (`addUsage(usage, 'researcher')`) still works. Bound the child itself
  with its own `loop: { maxSteps }` and `budget`.
- **Cancellation.** Pass the tool's `abortSignal` to the child's `send()`: aborting the parent turn
  aborts the child turn.
- **Clean up.** Child sessions stay cached until evicted (`sessionIdleMs`, default 30 min); call
  `researcher.closeSession(child.id)` when a child is done for good.
