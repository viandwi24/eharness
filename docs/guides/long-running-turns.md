# Long-running turns

An agent that migrates a code base or researches a topic may need hundreds of steps in one turn.
eharness does not cap turns at a small step count; it bounds them by **progress**: a turn may run
as long as it keeps doing something new, and stops when it repeats itself, fails over and over, or
runs out of its step, token, time or USD budget. Contracts: spec 05 §3.1–3.2, ADR-0015. Runnable:
[`examples/long-running.ts`](../../examples/long-running.ts).

## The loop configuration

```ts
import { defineHarnessAgent } from 'eharness'

const agent = defineHarnessAgent({
  model,
  contextWindow: 200_000,
  loop: {
    maxSteps: 500, // default — step budget per turn (send(…, { maxSteps }) overrides it per call)
    wrapUp: true, // default — one tool-less summary step when the budget runs out
    progress: {
      repeats: 3, // default — the same call with the same result 3× in the window
      window: 20, // default — the last 20 steps that called tools
      errorStreak: 5, // default — 5 steps in a row whose tool calls all failed
      nudges: 1, // default — reminders before stopping; 0 stops at once
      ignoreTools: ['wait_for_ci'], // tools that may repeat legitimately (polling)
    },
    maxIdleContinues: 3, // default — see "Keeping a turn going"
    maxContinues: undefined, // default none — absolute cap on continuations
    maxTurnOutputTokens: undefined, // default none — output-token cap → 'cost-cap'
    turnTimeoutMs: 30 * 60_000, // example: 30 min (default none) — wall clock → 'timeout'
  },
})
```

`loop.progress: false` switches the guard off. There is also `loop.persistEachStep` (default
`true`): the assistant message is saved after every step, so a long turn is never lost as a whole.

## How a long turn ends

After every step the first matching rule decides (spec 05 §3.1):

| Stop | When |
|---|---|
| `'error'` | the provider or stream failed (tool errors do **not** end the turn) |
| `'length'` / `'content-filter'` | the provider's finish reason |
| `'complete'` | the model answered without tool calls |
| `'tool-pending'` | a call waits for approval or a client-side tool |
| `'plugin:<name>:<reason>'` | a `step.end` hook returned `{ stop }` |
| `'max-steps'` | the step budget is used up (after the wrap-up step, below) |
| `'cost-cap'` | `loop.maxTurnOutputTokens` exceeded, or a USD `budget` used up ([models and cost](models-and-cost.md)) |
| `'stuck'` | the progress guard found the turn stuck and the reminder did not help |
| `'context-thrash'` | the context filled up again right after a compaction ([compaction](compaction.md#when-a-turn-thrashes)) |

Outside a step: `'aborted'` (`run.abort()`, `session.abort()`, your `abortSignal`), `'timeout'`
(`loop.turnTimeoutMs` or a per-step `settings.timeout`), `'blocked'` (an `input.submit` hook) and
`'interrupted'` (the process died; set by crash recovery). A step in flight is never cut short by
the step, token or USD limits, so the final numbers can exceed a limit by one step.

```ts
const result = await session.send('Migrate the test suite').result
switch (result.stop) {
  case 'complete':
    break
  case 'max-steps': // the last text is the model's wrap-up summary
  case 'stuck': // the model was reminded once and kept repeating itself
  case 'cost-cap':
    await notifyOwner(result)
    break
  default:
    console.log(result.stop, result.error?.message)
}
```

## The progress guard

After every step the core records each tool call as *(tool name, input, output)* — compared as
JSON with sorted keys. Denied calls and `ignoreTools` are skipped.

- **Repeat:** the same key `repeats` (3) times within the last `window` (20) tool steps — this also
  catches A → B → A → B cycles.
- **Error streak:** `errorStreak` (5) steps in a row whose tool calls all returned errors.

The first time, the next step gets the reminder `PROGRESS_NUDGE` ("You are not making progress: …
Try a different approach, or stop and explain what blocks you.") and `W_LOOP_STUCK` is raised with
`details: { kind, toolName?, count, stepIndex }`; the window is cleared. If the model gets stuck
again, the turn stops with `'stuck'`. The reminder is a step reminder: never stored, never in the
system prompt, so the prompt cache is unaffected.

Tools that legitimately return the same thing (polling a job, waiting) belong in `ignoreTools`.
A tool that returns an error **string** (`ERROR: …`, the recommended style) is an ordinary output
for the error streak, but still counts for repeats when the same call keeps producing it.

## The wrap-up step

When the step budget runs out (and no `turn.beforeEnd` hook extended it), the loop runs **one**
more step with tools disabled (`toolChoice: 'none'`) and the reminder `MAX_STEPS_WRAP_UP`: "The
step limit of this turn is reached and tools are disabled. Summarize what you did, what is left,
and how to continue." The turn still ends with `'max-steps'`, but the user gets a useful last
message instead of a half-finished tool call. `loop.wrapUp: false` stops immediately; a used-up
USD budget skips the wrap-up step too.

## Keeping a turn going

A `turn.beforeEnd` hook runs when the loop is about to stop with `'complete'`, `'max-steps'` or
`'length'`, and can ask for more:

```ts
import { definePlugin } from 'eharness'

const checks = definePlugin({
  name: 'checks',
  setup: () => ({
    hooks: {
      'turn.beforeEnd': (ctx, e) => {
        if (e.stop === 'max-steps') return { extendSteps: 50 } // raise the budget
        if (e.stop === 'complete' && !e.lastText.includes('All tests pass')) {
          return { continue: { reason: 'Run the tests and fix failures before you finish.' } }
        }
        return undefined
      },
    },
  }),
})
```

- `continue` delivers its reason as a `data-eh.input` part (stored where the model saw it) and
  runs one more step; `extendSteps` raises the step budget (only for `'max-steps'`).
- Continuations are bounded by progress: the event carries `continues` (so far in this turn) and
  `idleContinues` (continuations in a row after which no new successful tool result appeared).
  Once `loop.maxIdleContinues` (3) continuations in a row were idle, further ones are refused with
  `W_CONTINUE_LIMIT` (`details.reason: 'no-progress'`). `loop.maxContinues` adds an absolute cap
  (`details.reason: 'max'`). A used-up budget or an abort always wins.
- The [todos plugin](todos.md) with `enforce: true` is a ready-made `turn.beforeEnd` user.

## Talking to a long turn

- `session.send(text, { ifBusy: 'steer' })` delivers input at the next step boundary, and
  `ifBusy: 'queue'` runs it as the next turn ([approvals and interaction](approvals-and-interaction.md)).
- `session.inject(kind, data, { deliver: 'next-step' })` hands background events to the running turn.
- `session.attach()` lets a reconnecting client replay and follow the running turn;
  `session.events()` reports `turn-start` / `turn-end` / `status` for "agent is working" UIs.
- `run.abort()` / `session.abort()` stop it; partial output is saved with `stop: 'aborted'`.

## Stopping a turn from another instance

Behind a load balancer the Stop request often reaches a different server than the one running the
turn. `session.abort()` handles that too: when no turn of the session runs in this process, it
writes an abort request into the session state, and the owning instance stops the turn at its next
step boundary — or mid-tool, through the tool's `abortSignal` — with `stop: 'aborted'`, exactly
like a local abort (partial output saved, queue dropped, waiting steers reported as
`input-dropped`). Use `requestAbort()` to know where the abort went:

```ts
const { target } = await agent.session(chatId).requestAbort('user pressed stop')
// 'local'       — the turn ran in this process and was aborted
// 'remote'      — the turn runs in another instance; it stops within `abortPollMs`
// 'idle'        — no turn runs anywhere (nothing written)
// 'unsupported' — the StateAdapter has no setIf, or recovery: false (W_ABORT_UNSUPPORTED)
```

Requirements and cost:

- The `StateAdapter` must implement `setIf` atomically (compare-and-set on `rev`), see
  [writing a storage adapter](writing-a-storage-adapter.md). Without it nothing is written: a
  blind write would overwrite the owner's state.
- The owner reads the state at most once per `recovery.abortPollMs` (default 2 000 ms) while a
  turn runs; turns shorter than that read nothing. `abortPollMs: 0` turns the poll off (a request
  is then only noticed when an owner write conflicts with it).
- The request names the turn, so a late Stop never stops the next turn.

Runnable: [`examples/remote-abort.ts`](../../examples/remote-abort.ts).

## Budgets for unattended runs

Nothing limits spending by default. For agents that run without a person watching, combine:

- `budget: { maxTurnUsd, maxSessionUsd }` with `models` pricing ([models and cost](models-and-cost.md));
- `loop.turnTimeoutMs` for a wall-clock limit;
- `loop.maxTurnOutputTokens` if you think in tokens rather than dollars;
- `settings.maxRetries` for provider rate limits (AI SDK retries 429/5xx).

Long turns also grow the context: compaction summarizes older turns and, mid-turn, older steps of
the running turn (spec 06), and `toolOutput.maxChars` keeps single tool results bounded.
