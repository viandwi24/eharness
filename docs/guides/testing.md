# Testing your agent

`eharness/testing` runs agents without a model provider and proves your adapters correct. Every
example in this repository runs offline this way. Deeper notes for contributors:
[`docs/engineering/testing.md`](../engineering/testing.md).

## A scripted model

`scriptedModel(script)` is an AI SDK mock model (`MockLanguageModelV4`) that plays one script entry
per model call — one eharness step, or one `generateText` call such as the compaction summarizer —
and records what it was sent.

```ts
import { expect, test } from 'bun:test'
import { tool } from 'ai'
import { defineHarnessAgent } from 'eharness'
import { scriptedModel } from 'eharness/testing'
import { z } from 'zod/v4'

test('the agent looks the price up before answering', async () => {
  const model = scriptedModel([
    { toolCalls: [{ toolName: 'get_price', input: { sku: 'A1' } }] },
    { text: 'It costs 12 EUR.', usage: { inputTokens: 1_200, outputTokens: 20 } },
  ])
  const agent = defineHarnessAgent({
    model,
    contextWindow: 200_000,
    tools: {
      get_price: tool({
        inputSchema: z.object({ sku: z.string() }),
        execute: async () => '12.00 EUR',
      }),
    },
  })

  const result = await agent.session('t1').send('What does A1 cost?').result
  expect(result.stop).toBe('complete')
  expect(result.steps).toBe(2)
  expect(JSON.stringify(model.prompts[1])).toContain('12.00 EUR') // step 1 saw the tool result
  await agent.close()
})
```

A script entry (`ScriptedStep`) can set `text`, `reasoning`, `toolCalls` (with optional
`toolCallId`), `finishReason`, `usage` (`inputTokens`, `outputTokens`, `cacheReadTokens`,
`cacheWriteTokens`; default 10 / 5), `throws` (fail before streaming, e.g. an `APICallError` with
status 429), `streamError`, `delayMs` (for abort and timeout tests) or raw `parts`. An entry may
also be a function of the call options. `model.prompts` and `model.calls` hold every call's prompt
and full options (tools, tool choice, provider options).

`scriptedModel(script, { provider, modelId })` names the model — for example
`{ provider: 'anthropic.messages', modelId: 'claude-sonnet-4-6' }` to match a `models` catalog
entry or to exercise Anthropic cache options.

Useful assertions besides `run.result`: `session.messages()` (what was stored), the chunks of
`run.stream` (what the UI got), `onWarning` (collect warnings into an array), and a
`inMemoryState()` (from `eharness/storage/memory`) instance you pass in `storage` (read `state.get(sessionId)`).

## Conformance suites

Each suite returns runner-agnostic cases `{ name, run }` (`ConformanceCase`):

```ts
import { describe, test } from 'bun:test' // or vitest / node:test
import { uuidv7 } from 'eharness'
import {
  idGeneratorConformance,
  messageAdapterConformance,
  stateAdapterConformance,
} from 'eharness/testing'

describe('my storage', () => {
  for (const c of messageAdapterConformance(() => myMessages(), { requireLastId: true })) {
    test(c.name, c.run)
  }
  for (const c of stateAdapterConformance(() => myState(), { requireSetIf: true })) {
    test(c.name, c.run)
  }
  for (const c of idGeneratorConformance(() => uuidv7)) test(c.name, c.run)
})
```

| Suite | For | Options |
|---|---|---|
| `messageAdapterConformance(factory)` | `MessageAdapter` ([storage guide](writing-a-storage-adapter.md)) | `requireLastId` |
| `stateAdapterConformance(factory)` | `StateAdapter` | `requireSetIf` |
| `fileSystemConformance(factory)` | `FileSystem` ([filesystem guide](filesystem.md)) | `requireStat`, `requireGrep` |
| `skillSourceConformance((skills) => source)` | `SkillSource` ([skills guide](skills.md)); serve exactly `SKILL_SOURCE_FIXTURE` | `context`, `meta` |
| `lockConformance(factory)` | `SessionLock` ([storage guide](writing-a-storage-adapter.md)); the factory returns a lock or `{ lock, peer?, expire? }` | `concurrency`, `maxAcquireMs` |
| `idGeneratorConformance(factory)` | a custom `generateId` (ids must sort by creation time) | `uuidv7`, `floor`, `count` |

Cases use random session ids, so a factory may return adapters over one shared test database.

`messageAdapterConformance` also checks concurrent writes: saves of one id from parallel callers
must end with one row (`save` is an atomic upsert), disjoint concurrent batches must all be
visible, and ids that share a millisecond prefix must list in a deterministic id order.

## Session invariants in your own tests

`debug: { invariants: true }` makes the core check the stored session after every turn
(spec 05 §15) and report a problem as the `W_INVARIANT_VIOLATION` warning. It is explicit only: it
is never switched on by `NODE_ENV` or a test runner. In your suite, enable it on the agents under
test, collect warnings, and assert that none is an invariant violation (a throwing handler is
swallowed by the core, which must never break a running session):

```ts
// yours: model
const warnings: string[] = []
const agent = defineHarnessAgent({
  model,
  debug: { invariants: true },
  onWarning: (w) => warnings.push(w.code),
})
// ... run turns ...
expect(warnings).not.toContain('W_INVARIANT_VIOLATION')
```

`assertStoredSessionInvariants(state, messages)` (from `eharness/testing`) runs the same check on
a stored state snapshot and its messages. (The eharness repository itself does this in a Bun test preload; you do not need a
preload for application tests.)
