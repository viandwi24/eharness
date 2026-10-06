/**
 * External waits (park and resume): a "build" tool hands its work to a CI system and the turn
 * parks (`'tool-pending'`) without holding a process. Later a webhook arrives at ANOTHER instance,
 * which records the result with `session.resolveWait()` and continues the very same assistant
 * message. A second build never reports back: its `timeoutMs` and the durable `wait-timeout`
 * inbox item resolve it with an explicit timeout result.
 *
 *   bun examples/external-wait.ts
 *
 * In production the storage and the inbox are a database (see `postgres-storage.ts`,
 * `postgres-inbox.ts`) and the webhook is an HTTP route that checks the CI signature first.
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { defineHarnessAgent, externalTool } from 'eharness'
import { memoryInbox, memoryMessages, memoryState } from 'eharness/storage/memory'
import { z } from 'zod/v4'
import { exampleModel } from './shared/model.ts'

const storage = { messages: memoryMessages(), state: memoryState(), inbox: memoryInbox() }

/** The fake CI system: remembers what it was asked to build (an idempotency key per wait). */
const ci = new Map<string, string>()

const build = externalTool({
  description: 'Run a CI build for a git ref and wait for its result.',
  inputSchema: z.object({ ref: z.string() }),
  outputSchema: z.object({ ok: z.boolean(), summary: z.string() }),
  // runs once per call, after the step ended and before the turn parks; `waitId` is stable, so a
  // retried start is idempotent for the CI system
  start: ({ ref }, { waitId }) => {
    ci.set(waitId, ref)
    return { correlationId: `ci:${ref}`, payload: { ref } }
  },
  timeoutMs: 60_000,
  onTimeout: { output: { ok: false, summary: 'The build did not report back in time.' } },
})

// a build that never reports back: a short timeout, resolved by the inbox timer
const flaky = externalTool({
  description: 'Run a slow integration build and wait for its result.',
  inputSchema: z.object({ ref: z.string() }),
  start: ({ ref }, { waitId }) => {
    ci.set(waitId, ref)
  },
  timeoutMs: 150,
  // default onTimeout: the model sees WAIT_TIMED_OUT as a tool error
})

const model = exampleModel([
  { toolCalls: [{ toolName: 'build', input: { ref: 'main' } }] },
  { text: 'The build of main passed (42 tests).' },
  { toolCalls: [{ toolName: 'flaky', input: { ref: 'feature/x' } }] },
  { text: 'The integration build never reported back; I will retry it later.' },
])

const settings = {
  model,
  contextWindow: 200_000,
  storage,
  // short poll for the demo (default 2 s); the inbox holds the durable timeout timers
  inbox: { pollMs: 40 },
}
const web = defineHarnessAgent({ ...settings, tools: { build, flaky } }) // the chat server
const worker = defineHarnessAgent({ ...settings, tools: { build, flaky } }) // the webhook server

// 1. the turn parks: no process is held, the pending state is stored
const chat = web.session('chat-1')
const first = await chat.send('Build main and tell me whether it passes.').result
const wait = first.pending?.externals?.[0]
console.log(`A: turn 1 → ${first.stop}; waiting on ${wait?.waitId} (${wait?.correlationId})`)

// 2. the webhook reaches another instance: record the result, continue the same message
const webhook = worker.session('chat-1')
console.log(`B: pending waits → ${(await webhook.pendingWaits()).map((w) => w.waitId).join(', ')}`)
const resolved = await webhook.resolveWait(wait?.waitId as string, {
  output: { ok: true, summary: '42 tests passed' },
})
if (resolved.status === 'continued') {
  const result = await resolved.run.result
  console.log(
    `B: resolveWait → ${resolved.status}; the same message continued: ${result.messageId === first.messageId}`,
  )
}
// the webhook is delivered twice: a no-op
console.log(
  `B: replayed webhook → ${(await webhook.resolveWait(wait?.waitId as string, { output: { ok: true, summary: 'again' } })).status}`,
)

// 3. a build that never reports back: the inbox timer expires it, whichever instance holds the
//    session, and the model sees the explicit timeout result
const second = await chat.send('Now the integration build of feature/x.').result
console.log(`A: turn 2 → ${second.stop}; timeout at +150 ms`)
await web.close() // the chat server goes away; the worker still applies the timer
const worker2 = worker.session('chat-1')
for (let i = 0; i < 200; i++) {
  if ((await worker2.pendingWaits()).length === 0) break
  await sleep(20)
}
await worker2.idle()
const messages = await worker2.messages({ limit: 10 })
const last = messages.at(-1)
const text = (last?.parts ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('')
console.log(`B: timeout applied by the inbox timer; last answer: ${text}`)

await worker.close()
