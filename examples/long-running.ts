/**
 * Long-running turns: no small step cap, but a progress guard that stops a turn which repeats
 * itself (`'stuck'`), and a wrap-up step when the step budget runs out (`'max-steps'`).
 *
 *   bun examples/long-running.ts
 */
import { tool } from 'ai'
import { defineHarnessAgent, type HarnessWarning } from 'eharness'
import { z } from 'zod/v4'
import { exampleModel } from './shared/model.ts'

const onWarning = (w: HarnessWarning) => console.log(`  warning ${w.code}: ${w.message}`)
const fetchPage = tool({
  description: 'Fetch a web page.',
  inputSchema: z.object({ url: z.string() }),
  execute: async ({ url }) =>
    url.endsWith('/missing') ? `ERROR: 404 for ${url}` : `<h1>${url}</h1>`,
})

// 1. The progress guard: the same call with the same result 3 times → one reminder
//    (PROGRESS_NUDGE, W_LOOP_STUCK); the model repeats it 3 more times → stop 'stuck'.
const again = { toolCalls: [{ toolName: 'fetch_page', input: { url: 'https://x.dev/missing' } }] }
const looping = defineHarnessAgent({
  model: exampleModel([again, again, again, again, again, again, { text: 'never reached' }]),
  contextWindow: 200_000,
  tools: { fetch_page: fetchPage },
  loop: { progress: { repeats: 3, window: 20, errorStreak: 5, nudges: 1 } }, // the defaults
  onWarning,
})
console.log('progress guard:')
const stuck = await looping.session('a').send('Read https://x.dev/missing').result
console.log(`  → ${stuck.stop} after ${stuck.steps} steps`)

// 2. Wrap-up: when `maxSteps` runs out, one more step without tools asks the model to summarize
//    what is done and what is left (MAX_STEPS_WRAP_UP). The stop stays 'max-steps'.
const page = (n: number) => ({
  toolCalls: [{ toolName: 'fetch_page', input: { url: `https://x.dev/page/${n}` } }],
})
const busy = defineHarnessAgent({
  model: exampleModel([
    page(1),
    page(2),
    page(3),
    { text: 'Read pages 1–3 of 10. Next: continue with page 4.' },
  ]),
  contextWindow: 200_000,
  tools: { fetch_page: fetchPage },
  loop: { maxSteps: 3, wrapUp: true }, // default: 500 steps, wrapUp on
  onWarning,
})
console.log('wrap-up:')
const run = busy.session('b').send('Read all 10 pages of https://x.dev')
let summary = ''
for await (const chunk of run.stream) if (chunk.type === 'text-delta') summary += chunk.delta
const capped = await run.result
console.log(`  → ${capped.stop} after ${capped.steps} steps: ${summary}`)

await looping.close()
await busy.close()
