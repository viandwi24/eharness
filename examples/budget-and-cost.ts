/**
 * Model catalog, cost and USD budgets: prices come from a models.dev excerpt, every turn records
 * its estimated cost, a tool reports a nested model call with `ctx.turn.addUsage`, and budgets
 * stop turns with `'cost-cap'`. The second part shares one budget ledger between two agent
 * instances: a per-user limit that spans sessions (spec 12 §4.1).
 *
 *   bun examples/budget-and-cost.ts
 *
 * All figures are estimates (spec 12 §3) — good for limits and dashboards, not for billing.
 */
import { generateText, tool } from 'ai'
import { defineHarnessAgent, definePlugin, modelsDevCatalog } from 'eharness'
import { memoryBudgetLedger, memoryState } from 'eharness/storage/memory'
import { z } from 'zod/v4'
import { exampleModel } from './shared/model.ts'

// In an app: `await (await fetch('https://models.dev/api.json')).json()`, cached by you.
// eharness never fetches anything itself. USD per 1M tokens.
const modelsDev = {
  anthropic: {
    models: {
      'claude-sonnet-4.6': {
        limit: { context: 200_000, output: 64_000 },
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
      },
      'claude-haiku-4.5': {
        limit: { context: 200_000, output: 64_000 },
        cost: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
      },
    },
  },
}
const models = modelsDevCatalog(modelsDev)

// Offline the scripted models are named like the catalog entries they are priced with.
const usage = (inputTokens: number, outputTokens: number) => ({
  usage: { inputTokens, outputTokens },
})
const search = (query: string) => ({ toolName: 'search', input: { query } })
const model = exampleModel(
  [
    // turn 1: $0.075 + $0.105 + $0.0975, plus $0.05 for the nested summarizer call
    { toolCalls: [search('context windows')], ...usage(20_000, 1_000) },
    {
      toolCalls: [{ toolName: 'summarize', input: { topic: 'context windows' } }],
      ...usage(30_000, 1_000),
    },
    { text: 'Context windows range from 128k to 1M tokens.', ...usage(30_000, 500) },
    // turn 2: $0.21 per step; the turn budget ($0.50) is used up after the third step
    { toolCalls: [search('pricing tiers')], ...usage(65_000, 1_000) },
    { toolCalls: [search('cache discounts')], ...usage(65_000, 1_000) },
    { toolCalls: [search('batch pricing')], ...usage(65_000, 1_000) },
    { text: 'never reached' },
  ],
  { provider: 'anthropic.messages', modelId: 'claude-sonnet-4.6' },
)
const summarizer = exampleModel([{ text: 'Summary: windows grow.', ...usage(40_000, 2_000) }], {
  provider: 'anthropic.messages',
  modelId: 'claude-haiku-4.5',
})

// Print the running cost after every step (`StepEndEvent.costUsd` is the turn so far).
const meter = definePlugin({
  name: 'meter',
  setup: () => ({
    hooks: {
      'step.end': (_ctx, e) => {
        console.log(`  step ${e.stepIndex}: turn so far $${e.costUsd?.toFixed(4)}`)
      },
    },
  }),
})

const state = memoryState()
const agent = defineHarnessAgent({
  model,
  models, // also supplies the context window (200k) — no `contextWindow` needed
  budget: { maxTurnUsd: 0.5, maxSessionUsd: 0.9, warnAt: 0.8 },
  storage: { state },
  onWarning: (w) => console.log(`  warning ${w.code}: ${w.message}`),
  plugins: [meter],
  tools: {
    search: tool({
      description: 'Search the web.',
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => `3 results for "${query}"`,
    }),
    // A tool that makes its own model call reports the usage to the turn, priced by `model`
    // (or pass `costUsd` when you know the exact cost, e.g. from a gateway response).
    summarize: (ctx) =>
      tool({
        description: 'Summarize the research on a topic with a small model.',
        inputSchema: z.object({ topic: z.string() }),
        execute: async ({ topic }) => {
          const result = await generateText({ model: summarizer, prompt: `Summarize: ${topic}` })
          ctx.turn?.addUsage(result.usage, { model: summarizer, source: 'summarizer' })
          return result.text
        },
      }),
  },
})

const session = agent.session('research')
const usd = (n: number | undefined) => (n === undefined ? 'nothing priced' : `$${n.toFixed(4)}`)

for (const [i, text] of [
  'What are context windows?',
  'Now research pricing',
  'One more',
].entries()) {
  console.log(`turn ${i + 1}: ${text}`)
  const result = await session.send(text).result
  console.log(`  → ${result.stop} after ${result.steps} steps, ${usd(result.usage.costUsd)}`)
}

const [, assistant] = await session.messages()
console.log(`stored on the first answer: ${usd(assistant?.metadata?.eharness?.usage?.costUsd)}`)
console.log(`session total: ${usd((await state.get('research'))?.core.usage?.costUsd)}`)
console.log(`context window from the catalog: ${(await session.stats()).window}`)

await agent.close()

// --- budgets across sessions -------------------------------------------------------------------
// Two agent instances (think: two servers) share one ledger. The user's limit spans every session:
// each model call first reserves an estimate on `user:<id>`, then commits its actual cost.
console.log('\nbudget ledger: user ada, $0.30 across sessions')
const ledger = memoryBudgetLedger({ limits: { 'user:ada': 0.3 } }) // in production: a database
const worker = () =>
  exampleModel(
    Array.from({ length: 5 }, (_, i) => ({
      toolCalls: [search(`topic ${i}`)],
      ...usage(20_000, 1_000),
    })),
    { provider: 'anthropic.messages', modelId: 'claude-sonnet-4.6' },
  )
const instance = () =>
  defineHarnessAgent({
    model: worker(),
    models,
    tools: {
      search: tool({ inputSchema: z.object({ query: z.string() }), execute: async () => 'ok' }),
    },
    onWarning: (w) => console.log(`  warning ${w.code}: ${w.message}`),
    budget: {
      ledger: {
        adapter: ledger,
        scopes: (ctx) => [`user:${String(ctx.runtime.userId)}`],
        // a flat estimate per call; the default prices the context + maxOutputTokens
        estimate: () => 0.08,
      },
    },
  })
const [serverA, serverB] = [instance(), instance()]
const first = await serverA.session('ada-chat-1', { runtime: { userId: 'ada' } }).send('Research')
  .result
console.log(`  server A: ${first.stop} after ${first.steps} steps, ${usd(first.usage.costUsd)}`)
const second = await serverB.session('ada-chat-2', { runtime: { userId: 'ada' } }).send('More')
  .result
console.log(`  server B: ${second.stop} after ${second.steps} steps`) // refused before its first call
const [ada] = (await ledger.check(['user:ada'])).scopes
console.log(`  ledger: spent ${usd(ada?.spentUsd)} of $0.30, reserved ${usd(ada?.reservedUsd)}`)
await serverA.close()
await serverB.close()
