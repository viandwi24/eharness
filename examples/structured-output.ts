/**
 * Structured final output: `send(input, { output: { schema } })` returns a typed, validated
 * answer in `result.output`. Tool mode (default) adds a `final_answer` tool for the turn; a wrong
 * answer is fed back to the model and retried (`maxRetries`). Native mode uses AI SDK's
 * `Output.object` (the provider's structured output).
 *
 *   bun examples/structured-output.ts
 */
import { tool } from 'ai'
import { defineHarnessAgent } from 'eharness'
import { z } from 'zod/v4'
import { exampleModel } from './shared/model.ts'

const triage = z.object({
  label: z.enum(['bug', 'feature', 'question']),
  priority: z.number().int().min(1).max(3),
  summary: z.string(),
})

const model = exampleModel([
  // turn 1 (tool mode): look something up, answer with prose, get the retry, then call final_answer
  { toolCalls: [{ toolName: 'search_issues', input: { query: 'login timeout' } }] },
  { text: 'This looks like a bug in the login flow.' },
  {
    toolCalls: [
      {
        toolName: 'final_answer',
        input: {
          label: 'bug',
          priority: 1,
          summary: 'Login times out after 30 s (duplicate of #12).',
        },
      },
    ],
  },
  // turn 2 (native mode): the answer is JSON text, parsed and validated by AI SDK
  { text: JSON.stringify({ label: 'question', priority: 3, summary: 'How to export data.' }) },
])

const agent = defineHarnessAgent({
  model,
  contextWindow: 200_000,
  instructions: 'You triage support tickets.',
  tools: {
    search_issues: tool({
      description: 'Search existing issues.',
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => `#12 "${query}" (open)`,
    }),
  },
})

const session = agent.session('triage')

const run = session.send('Ticket: "Login times out after 30 seconds."', {
  output: { schema: triage },
})
for await (const chunk of run.stream) {
  // the retry is delivered inside the assistant message (source 'plugin:eh.output')
  if (chunk.type === 'data-eh.input') console.log(`retry: ${chunk.data.text.split('\n')[0]}`)
  // the validated answer is stored as `data-eh.output` (never sent to the model)
  if (chunk.type === 'data-eh.output') console.log(`stored after ${chunk.data.attempts} attempts`)
}
const first = await run.result
// `first.output` is typed: { label: 'bug' | 'feature' | 'question'; priority: number; summary: string }
console.log(
  `${first.stop}: ${first.output?.label} p${first.output?.priority} — ${first.output?.summary}`,
)

const second = await session.send('Ticket: "How do I export my data?"', {
  output: { schema: triage, mode: 'native' },
}).result
console.log(`${second.stop}: ${second.output?.label} p${second.output?.priority}`)

await agent.close()
