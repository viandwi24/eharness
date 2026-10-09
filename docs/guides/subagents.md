# Subagents

`eharness/subagent` adds the `agent` tool: the model delegates a self-contained task to another
agent, which runs as a **child session** with its own history, tools and plugins, and gets back a
final report. Contract: [spec 20](../specs/20-subagent-plugin.md). Design:
[ADR-0034](../decisions/0034-deployment-profiles.md) (three deployment profiles),
[ADR-0035](../decisions/0035-nested-approvals-park-the-parent.md) (nested approvals).

```ts
import { defineHarnessAgent } from 'eharness'
import { subagents } from 'eharness/subagent'

const explorer = defineHarnessAgent({ model, storage, instructions: 'Read and report. Be brief.', tools: { read_file } })

const main = defineHarnessAgent({
  model,
  storage, // the same storage: the child registers in the parent's state
  plugins: [
    subagents({
      agents: { explore: { agent: explorer, description: 'Reads the codebase and reports', maxTurns: 12 } },
      approvals: 'policy', // see "The three strategies"
    }),
  ],
})
```

What you get: progress of the child as **preliminary tool outputs** (`SubagentProgress`: status,
steps, last tool, latest text; UI only), the child's tokens and cost added to the parent turn
(`ctx.turn.addUsage`, so budgets count them), abort propagation (aborting the parent turn aborts
the child), a depth limit (`maxDepth`, default 2), a per-depth concurrency cap (`maxConcurrent`,
default 8) and a persisted data part `data-subagent.run` `{ toolCallId, sessionId, agent, status }`
so a UI can open the child transcript (`explorer.session(sessionId).messages()`) after a reload.
Children are found again with `parentSession.children()`.

## The three strategies for the child's approvals

A child can stop `tool-pending` (an approval, or a client tool such as `ask_user_question`).
`approvals` decides who answers.

| `approvals` | Profile | What happens |
|---|---|---|
| `'policy'` | (a) autonomous server | answered automatically: `policy: 'deny'` (default; the child reads "No user is available; this action is not allowed in autonomous mode.") or `'approve'`. Client tool calls get an error text. Nothing ever waits. |
| `'inline'` | (b) CLI, one process | `answer(request, signal)` is awaited in process; the child continues with `respond()`. Return `{ approved, reason?, note?, remember? }` for approvals and `{ output }` / `{ errorText }` for client tools. |
| `'park'` | (c) web + server, restarts, several instances | the parent parks as an external wait; you answer the **child** session later, from any instance. |

### Inline

```ts
subagents({
  agents,
  approvals: 'inline',
  answer: async (request, signal) => {
    if (request.type === 'client-tool') return { errorText: 'Not supported here.' }
    const ok = await ui.confirm(`${request.agent} wants to run ${request.toolName}`, signal)
    return ok ? { approved: true } : { approved: false, reason: 'Not now; try another way.' }
  },
})
```

### Park

```ts
const holder: { main?: HarnessAgent } = {}
const worker = defineHarnessAgent({
  model, storage,
  tools: { deploy },
  approval: { policy: { deploy: 'user-approval' } },
  plugins: [subagentChild({ parent: () => holder.main! })],   // resolves the parent's wait when the child finishes
})
const main = (holder.main = defineHarnessAgent({
  model, storage,
  plugins: [subagents({ agents: { worker: { agent: worker, description: '...' } }, approvals: 'park', timeoutMs: 3_600_000 })],
}))
```

1. The parent turn calls `agent`; the child runs. When it stops `tool-pending`, the **parent stops
   `tool-pending` too**, with an external wait whose payload names the child and its pending items
   (`await session.pendingWaits()`). Nothing is held in memory.
2. Show the question to the user. List what waits, from any instance:
   `await pendingSubagentApprovals(main.session(parentId), worker)`.
3. Answer the child: `worker.session(childId).respond({ approvals: [{ id, approved: true }] })`.
   It may stop `tool-pending` again; repeat.
4. When the child's turn completes, in whichever instance, its `turn.end` hook (from
   `subagentChild`) resolves the parent's wait with the final report and the parent continues by
   itself, in the same assistant message. A child error or abort resolves it with an `ERROR:` text.

Rules: install `subagentChild()` (or `subagents({ parentAgent })`) on every instance that can
complete a child turn, use storage with `setIf` or a lock (as for any external wait), and set
`timeoutMs` so a forgotten approval does not park the parent forever. A restart between the park
and the answer loses nothing. There is no live progress and no `run_in_background` in this
strategy. The continuation run that the child's completion starts on the parent is drained and
stored; pass `onParentRun` to stream it to the user.

**Crash recovery.** If the process dies after a child finished and before its hook resolved the
parent's wait, the parent would stay parked until `timeoutMs`.
`reconcileSubagentWaits(parentSession, { openChild })` resolves such waits from the child's stored
result (idempotent, safe to call from a timer or an admin endpoint). With
`subagents({ approvals: 'park', selfAgent: () => parentAgent })` it also runs, detached and best
effort, whenever a parent session opens. Spec 20 §3.4.

## Background children

`background: true` (inline and policy only) adds `run_in_background`. The call returns at once; when
the child finishes, the plugin injects an `eh.event` into the parent with `ctx.session.inject`
(`deliver: 'next-step'`, `wake: true`): a running parent sees it at its next step, an idle one
wakes. The report is stored in the history, so it survives a UI restart.

**Task list.** `ctx.services.subagentTasks` (like `shellTasks`) lists the background children of a
session for a UI: `list()`, `get(id)` (task id `agent-1` or child session id), `stop(id)`,
`stopAll()`, `subscribe(listener)`; an entry is `{ id, agent, description, childSessionId, status:
'running' | 'completed' | 'failed' | 'stopped', startedAt, endedAt?, tail }`. It is per process and
live session; the durable records are the `data-subagent.run` part (`running`, written while the
starting turn streams) and the `eh.event` report (`data.status` `completed` / `failed` /
`stopped`). `stop()` aborts the child; for an id the process does not know it calls
`requestAbort()` on the child session, which reaches a child running in another instance.

**Moving a foreground child to the background.** `ctx.services.subagentTasks.background()` (Claude
Code's Ctrl+B) detaches the running foreground `agent` calls: each returns at once with "Subagent
moved to the background as task agent-2 …", the child keeps running and reports through the same
`eh.event` path as `run_in_background`. Needs `background: true`; not available for `'park'`.

**Wake turns.** A report wakes an idle parent with a turn nobody started: use
`session.onRun((run) => …)` to stream it and answer its approvals (spec 05 §2.1); in
multi-instance deployments use `events()` + `attach()`.

**Children of children.** A child session is closed when its turn ends, which aborts the
background subagents it started, and a report for it would go to a session nobody watches. So
`run_in_background` is offered to the root session only; set `backgroundInChildren: true` if your
child sessions stay open. Do the same for shell background tasks: give child agents a `shell()`
without `background` (a separate child agent definition), so every report reaches the session the
user sees.

## Appendix: the manual pattern

The plugin is a convenience; a subagent is just a tool that opens a child session. If you need
something the plugin does not offer, this is the whole mechanism. Runnable:
[`examples/subagent-tool.ts`](../../examples/subagent-tool.ts).

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
          if (turn === undefined) {
            // expected failure: return an error string the model can read, never throw
            yield 'ERROR: research runs only inside a turn.'
            return
          }
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
