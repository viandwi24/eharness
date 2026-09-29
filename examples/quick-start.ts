// The README quick start. `examples/examples.test.ts` checks that the README block equals the
// code between the markers below, with the `model:` line replaced by the README's gateway string.
import { exampleModel } from './shared/model.ts'

const demoModel = exampleModel([
  { toolCalls: [{ toolName: 'get_time', input: {} }] },
  {
    toolCalls: [
      { toolName: 'write_file', input: { path: '/notes/now.md', content: '- 12:00 started\n' } },
    ],
  },
  { text: 'Saved the note to /notes/now.md.' },
])

// --- quick start ---
import { tool } from 'ai'
import { defineHarnessAgent, defineSkill } from 'eharness'
import { filesystem } from 'eharness/filesystem'
import { memoryFs } from 'eharness/filesystem/memory'
import { z } from 'zod/v4'

const agent = defineHarnessAgent({
  model: demoModel,
  contextWindow: 200_000,
  instructions: 'You are a careful assistant. Keep notes as files under /notes.',
  tools: {
    get_time: tool({
      description: 'Current time as an ISO string',
      inputSchema: z.object({}),
      execute: async () => new Date().toISOString(),
    }),
  },
  skills: [
    defineSkill({
      name: 'note-style',
      description: 'Use before writing a note.',
      content: 'Bullets only.',
    }),
  ],
  plugins: [filesystem({ fs: memoryFs() })],
})

const session = agent.session('demo')
const run = session.send('Write the current time to /notes/now.md')
for await (const chunk of run.stream) {
  if (chunk.type === 'text-delta') process.stdout.write(chunk.delta) // or: run.toResponse()
}

const result = await run.result // never rejects: errors end the turn with stop: 'error'
console.log(`\n${result.stop} after ${result.steps} steps`)
console.log(`${(await session.messages()).length} messages stored`)
// --- end quick start ---

await agent.close()
