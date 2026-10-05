/**
 * Pre-compaction flush (spec 06 §5.2a): before history is summarized, the agent gets one short,
 * internal turn to save what must survive — here into memory files (`flushOnCompaction`) and
 * through a plain custom tool of another plugin. Both requests merge into one flush. The flush
 * leaves no trace in the conversation; only a model-invisible `eh.flush` audit message is stored,
 * right before the compaction marker.
 *
 *   bun examples/compaction-flush.ts
 */
import { tool } from 'ai'
import {
  defineHarnessAgent,
  definePlugin,
  type FlushPayload,
  type HarnessUIMessage,
  isKindMessage,
} from 'eharness'
import { filesystem } from 'eharness/filesystem'
import { memoryFs } from 'eharness/filesystem/memory'
import { memory } from 'eharness/memory'
import { memoryMessages } from 'eharness/storage/memory'
import { z } from 'zod/v4'
import { exampleModel } from './shared/model.ts'

const fs = memoryFs({})
const facts: string[] = []

/** A plugin with its own tool that asks for the same flush. */
const factLog = definePlugin({
  name: 'facts',
  setup: () => ({
    tools: {
      save_fact: tool({
        description: 'Record a fact in the project fact log.',
        inputSchema: z.object({ fact: z.string() }),
        execute: async ({ fact }) => {
          facts.push(fact)
          return 'Saved.'
        },
      }),
    },
    hooks: {
      'compaction.before': (_ctx, e) => ({
        flush: {
          prompt: `Also record project facts with save_fact (${e.messages.length} messages will be summarized).`,
          tools: ['save_fact'],
        },
      }),
    },
  }),
})

// The compaction model runs the flush (two calls) and then writes the summary.
const compactionModel = exampleModel([
  {
    toolCalls: [
      {
        toolName: 'memory_create',
        input: { path: '/memories/users/u1/project.md', file_text: 'Launch moved to May 12.\n' },
      },
      { toolName: 'save_fact', input: { fact: 'Budget approved: 40k' } },
    ],
  },
  { text: 'Saved the launch date and the budget.' },
  { text: 'The user planned the launch (now May 12) and got the 40k budget approved.' },
])

const messages = memoryMessages()
const agent = defineHarnessAgent({
  model: exampleModel([
    { text: 'Got it: the launch moves to May 12.' },
    { text: 'Great, the 40k budget is approved.' },
    { text: 'The launch is on May 12.' },
  ]),
  contextWindow: 100_000,
  storage: { messages },
  compaction: { model: compactionModel, keepLast: 0, maxSummaryTokens: 300 },
  plugins: [
    filesystem({ fs, hiddenPrefixes: ['/memories'] }),
    memory({
      roots: (ctx) => [{ path: `/memories/users/${String(ctx.runtime.userId)}`, write: true }],
      flushOnCompaction: true,
    }),
    factLog,
  ],
  onWarning: (w) => console.log(`warning ${w.code}: ${w.message}`),
})

const session = agent.session('s1', { runtime: { userId: 'u1' } })
await session.send('Move the launch to May 12.').result
await session.send('Finance approved the 40k budget.').result

// Compact now (the same happens automatically when the context fills up).
const marker = await session.compact()
const summary = (marker?.parts[0] as { data: { summary: string } } | undefined)?.data.summary
console.log(`summary: ${summary}`)

const stored = (await messages.load({ sessionId: 's1' })) as HarnessUIMessage[]
const record = stored.find((m) => isKindMessage(m, 'eh.flush'))
const flush = (record?.parts[0] as { data: FlushPayload } | undefined)?.data
const calls = flush?.toolCalls.map((c) => `${c.toolName} ${c.status}`).join(', ')
console.log(`flush (${flush?.trigger}, ${flush?.steps} steps): ${calls}`)
console.log(`memory file: ${(await fs.read('/memories/users/u1/project.md'))?.content.trim()}`)
console.log(`fact log: ${facts.join('; ')}`)
console.log(`stored: ${stored.map((m) => m.metadata?.eharness?.kind ?? m.role).join(', ')}`)

// The next turn sees the summary, never the flush.
const next = await session.send('When is the launch?').result
console.log(`next turn: ${next.stop}`)
await agent.close()
