/**
 * Context pruning and the thrash stop (spec 06 §4, §5.0): the same tool-heavy session with
 * `compaction.prune` off and on. With prune on, old tool outputs are replaced by a short
 * placeholder in the request only, so the summarizer runs later (or never); stored messages stay
 * byte-identical. A turn whose context refills right after a compaction stops with
 * `'context-thrash'` instead of compacting again.
 *
 *   bun examples/context-prune.ts
 */
import { tool } from 'ai'
import { defineHarnessAgent, type HarnessWarning, isKindMessage, type PruneConfig } from 'eharness'
import { memoryMessages } from 'eharness/storage/memory'
import { z } from 'zod/v4'
import { exampleModel } from './shared/model.ts'

const TURNS = 16

/** A tool with large outputs (a build log). */
const readLog = tool({
  description: 'Read the build log of a job.',
  inputSchema: z.object({ job: z.number() }),
  execute: async ({ job }) => `job ${job}: ok\n${'compiling module… done\n'.repeat(250)}`,
})

/** Script of one session: every turn reads a log, then answers. */
function script(turns: number) {
  return Array.from({ length: turns }, (_, i) => [
    { toolCalls: [{ toolName: 'read_log', input: { job: i } }] },
    { text: `Job ${i} built fine.` },
  ]).flat()
}

async function session(prune: PruneConfig | undefined) {
  const messages = memoryMessages()
  const agent = defineHarnessAgent({
    model: exampleModel(script(TURNS)),
    contextWindow: 12_000,
    tools: { read_log: readLog },
    storage: { messages },
    compaction: {
      model: exampleModel(Array.from({ length: TURNS }, (_, i) => ({ text: `Summary ${i + 1}.` }))),
      maxSummaryTokens: 200,
      ...(prune === undefined ? {} : { prune }),
    },
    onWarning: () => {},
  })
  const s = agent.session('s1')
  for (let i = 0; i < TURNS; i++) {
    await s.send(`Check job ${i}.`).result
  }
  const stats = await s.stats()
  const stored = await messages.load({ sessionId: 's1' })
  const summaries = stored.filter((m) => isKindMessage(m, 'eh.compaction')).length
  await agent.close()
  return { summaries, stats, stored }
}

const off = await session(undefined)
const on = await session({ keepTurns: 2, minChars: 2_000 })
console.log(`prune off: ${off.summaries} compaction(s), next request ~${off.stats.tokens} tokens`)
console.log(
  `prune on:  ${on.summaries} compaction(s), next request ~${on.stats.tokens} tokens, ` +
    `${on.stats.pruned?.outputs} outputs pruned (${on.stats.pruned?.chars} chars saved)`,
)
const conversation = (list: typeof on.stored) =>
  list.filter((m) => !isKindMessage(m, 'eh.compaction')).map((m) => m.parts)
const same = JSON.stringify(conversation(on.stored)) === JSON.stringify(conversation(off.stored))
console.log(`stored conversation identical: ${same}`)

// The thrash stop: every step reads a huge log into a small window. After one compaction the
// context is above summarizeAt again within 2 steps → stop 'context-thrash' (W_CONTEXT_THRASH).
const readDump = tool({
  description: 'Read a full memory dump.',
  inputSchema: z.object({ n: z.number() }),
  execute: async ({ n }) => `dump ${n}\n${'0123456789abcdef'.repeat(2_000)}`,
})
const dump = (n: number) => ({ toolCalls: [{ toolName: 'read_dump', input: { n } }] })
const thrashing = defineHarnessAgent({
  model: exampleModel([dump(1), dump(2), dump(3), dump(4), dump(5), { text: 'never reached' }]),
  contextWindow: 12_000,
  tools: { read_dump: readDump },
  compaction: { model: exampleModel([{ text: 'Summary.' }]), maxSummaryTokens: 100 },
  onWarning: (w: HarnessWarning) => {
    if (w.code === 'W_CONTEXT_THRASH') console.log(`warning ${w.code}`)
  },
})
const thrash = await thrashing.session('t').send('Read every log.').result
console.log(`thrash: → ${thrash.stop} after ${thrash.steps} steps`)
await thrashing.close()
