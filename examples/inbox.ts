/**
 * Durable inbox: two agent instances ("process A" and "process B", e.g. two servers behind a load
 * balancer) share one storage and one inbox. Messages that reach B while A runs the turn are
 * stored in the inbox and applied by A: a steer at A's next step boundary, a burst of chat
 * messages merged into one turn (`collect`), and a Stop through the inbox. A poison item (a
 * stored input that no longer validates) goes to the dead-letter store instead of blocking its
 * session (`inbox.retry`, `onDeadLetter`).
 *
 *   bun examples/inbox.ts
 *
 * In production the inbox is a database table or a queue (see `postgres-inbox.ts`).
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { tool } from 'ai'
import { defineHarnessAgent } from 'eharness'
import { memoryInbox, memoryMessages, memoryState } from 'eharness/storage/memory'
import { z } from 'zod/v4'
import { exampleModel } from './shared/model.ts'

const storage = { messages: memoryMessages(), state: memoryState(), inbox: memoryInbox() }

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

// a slow tool: finishes when `gate` opens, or when the turn is aborted
let started = deferred()
let gate = deferred()
const lookup = tool({
  description: 'Look something up (slow).',
  inputSchema: z.object({ topic: z.string() }),
  execute: ({ topic }, { abortSignal }) =>
    new Promise<string>((resolve) => {
      started.resolve()
      abortSignal?.addEventListener('abort', () => resolve('Lookup cancelled.'))
      void gate.promise.then(() => resolve(`Notes about ${topic}.`))
    }),
})

const model = exampleModel([
  // turn 1 (A): a slow lookup; the steer from B arrives at the step boundary after it
  { toolCalls: [{ toolName: 'lookup', input: { topic: 'pricing' } }] },
  { text: 'The pro plan costs 20 EUR per month.' },
  // turn 2: the collected burst
  { text: 'Got all three messages at once.' },
  // turn 3: aborted during its lookup
  { toolCalls: [{ toolName: 'lookup', input: { topic: 'history' } }] },
  { text: 'never reached' },
])

const settings = {
  model,
  contextWindow: 200_000,
  storage,
  // short timings for the demo (defaults: pollMs 2_000, collect.quietMs 1_500)
  inbox: {
    pollMs: 50,
    collect: { quietMs: 100 },
    // poison items: dead after 5 counted attempts (or at once when non-retryable)
    retry: { maxAttempts: 5, backoff: { delayMs: 50 } },
    onDeadLetter: (item: { reason: string; lastError?: string }) => {
      console.log(`dead letter: ${item.reason} (${item.lastError?.split(':')[0]})`)
    },
  },
}
const processA = defineHarnessAgent({ ...settings, tools: { lookup } })
const processB = defineHarnessAgent(settings)
const sessionA = processA.session('chat-1')
const sessionB = processB.session('chat-1')

// 1. steer: B enqueues while A runs; A delivers it at its next step boundary
const run = sessionA.send('What does the pro plan cost?')
await started.promise
const steer = await sessionB.enqueue('Answer in EUR, please.', { mode: 'steer' })
console.log(`B: enqueue steer → ${steer.target}`)
await sleep(100) // A claims it (notified through the inbox)
gate.resolve()
const result = await run.result
const assistant = result.messages.find((m) => m.role === 'assistant')
const steered = assistant?.parts.some((p) => p.type === 'data-eh.input') === true
console.log(`A: turn 1 → ${result.stop}; steer delivered inside the turn: ${steered}`)

// 2. collect: a burst of three chat messages becomes one user message and one turn
for (const text of ['hi', 'one more thing:', 'what about discounts?']) {
  await sessionB.enqueue(text, { mode: 'collect' })
}
for (let i = 0; i < 200; i++) {
  if ((await sessionA.messages()).filter((m) => m.role === 'user').length === 2) break
  await sleep(20)
}
await sessionA.idle()
await sessionB.idle()
const merged = (await sessionA.messages()).filter((m) => m.role === 'user').at(-1)
const text = merged?.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
console.log(
  `collect: ${merged?.metadata?.eharness?.collected?.length} inputs → 1 message: ${JSON.stringify(text)}`,
)

// 3. abort through the inbox: B's Stop reaches the turn running in A
started = deferred()
gate = deferred()
const third = sessionA.send('Tell me the history.')
await started.promise
const { target } = await sessionB.requestAbort('user pressed stop')
console.log(`B: requestAbort → ${target}`)
console.log(`A: turn 3 → ${(await third.result).stop}`)

// 4. a poison item: a stored input that no longer validates goes dead instead of blocking
await storage.inbox.enqueue('chat-2', { kind: 'send', mode: 'queue', input: { parts: [] }, at: 0 })
const poisoned = processA.session('chat-2')
for (let i = 0; i < 200; i++) {
  if ((await storage.inbox.listDead?.({ sessionId: 'chat-2' }))?.length === 1) break
  await sleep(20)
}
await poisoned.idle()
console.log(`stats: ${JSON.stringify(await storage.inbox.stats?.({ sessionId: 'chat-2' }))}`)

await processA.close()
await processB.close()
