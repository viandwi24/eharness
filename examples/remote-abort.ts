/**
 * Cross-process abort: two agent instances ("process A" and "process B", e.g. two servers behind a
 * load balancer) share one storage. The Stop request reaches B, the turn runs in A: B writes an
 * abort request into the session state (`StateAdapter.setIf`), A finds it at its next poll
 * (`recovery.abortPollMs`) and ends the turn with `stop: 'aborted'`.
 *
 *   bun examples/remote-abort.ts
 */
import { tool } from 'ai'
import { defineHarnessAgent } from 'eharness'
import { memoryMessages, memoryState } from 'eharness/storage/memory'
import { z } from 'zod/v4'
import { exampleModel } from './shared/model.ts'

// shared storage: in production a database (`setIf` = UPDATE … WHERE rev = $expected)
const storage = { messages: memoryMessages(), state: memoryState() }

let started!: () => void
const toolStarted = new Promise<void>((resolve) => {
  started = resolve
})
// a long tool call that honours its abort signal
const crawl = tool({
  description: 'Crawl a whole site (slow).',
  inputSchema: z.object({ site: z.string() }),
  execute: ({ site }, { abortSignal }) =>
    new Promise<string>((resolve) => {
      started()
      const timer = setTimeout(() => resolve(`Crawled ${site}.`), 60_000)
      abortSignal?.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve('Crawl cancelled.')
      })
    }),
})

const processA = defineHarnessAgent({
  model: exampleModel([
    { toolCalls: [{ toolName: 'crawl', input: { site: 'https://x.dev' } }] },
    { text: 'never reached' },
  ]),
  contextWindow: 200_000,
  tools: { crawl },
  storage,
  recovery: { abortPollMs: 50 }, // default 2_000 ms: one state read per interval while a turn runs
})
const processB = defineHarnessAgent({
  model: exampleModel([]),
  contextWindow: 200_000,
  storage,
})

const run = processA.session('chat-1').send('Crawl https://x.dev')
await toolStarted
console.log('A: turn running, tool started')

// the user presses Stop; the request lands on B, which has no turn of this session
const { target } = await processB.session('chat-1').requestAbort('user pressed stop')
console.log(`B: requestAbort → ${target}`) // 'remote' ('local' if the turn ran here)

const result = await run.result
console.log(`A: turn ended → ${result.stop} after ${result.steps} step(s)`)
const stats = await processB.session('chat-1').stats()
console.log(`state: activeTurn ${stats.activeTurn === null ? 'cleared' : 'still set'}`)
