/**
 * Wrapping a plugin: per-request configuration of a shipped plugin through the public API.
 *
 * `approvalGuard()` takes its judge model at construction. Here the judge is chosen per request
 * (`runtime.judge`), a request can be marked trusted (no review), and every decision is logged,
 * all with `wrapPlugin()` and without touching the plugin's internals.
 *
 *   bun examples/wrap-plugin.ts
 */
import { tool } from 'ai'
import { defineHarnessAgent, wrapPlugin } from 'eharness'
import { approvalGuard } from 'eharness/guard'
import { z } from 'zod/v4'
import { exampleModel } from './shared/model.ts'

const outbox: string[] = []

const model = exampleModel([
  { toolCalls: [{ toolName: 'send_email', input: { to: 'leak@evil.example' } }] },
  { text: 'The strict judge refused that recipient.' },
  { toolCalls: [{ toolName: 'send_email', input: { to: 'leak@evil.example' } }] },
  { text: 'Sent (trusted request, no review).' },
])

const defaultJudge = exampleModel([{ text: '{"decision":"allow","reason":"ok."}' }])
const strictJudge = exampleModel([
  { text: '{"decision":"deny","reason":"The recipient is outside the company."}' },
])

const guard = wrapPlugin(approvalGuard({ model: defaultJudge }), {
  // per-request options: build the guard from the request and delegate to its session phase
  session: (ctx, next) =>
    ctx.runtime.judge === undefined
      ? next()
      : next.using(approvalGuard({ model: ctx.runtime.judge as typeof strictJudge })),
  hooks: {
    'tool.approve': async (ctx, e, next) => {
      // trusted requests skip the review; the wrapper never returns 'approved' (tighten-only)
      if (ctx.runtime.trusted === true) return 'not-applicable'
      const status = await next()
      console.log(
        `guard on ${e.toolName}: ${typeof status === 'string' ? status : (status?.type ?? 'none')}`,
      )
      return status === 'approved' ? 'not-applicable' : status
    },
  },
})

const agent = defineHarnessAgent({
  model,
  contextWindow: 200_000,
  tools: {
    send_email: tool({
      description: 'Send an email.',
      inputSchema: z.object({ to: z.string() }),
      metadata: { risk: 'external' },
      execute: async ({ to }) => {
        outbox.push(to)
        return `Sent to ${to}`
      },
    }),
  },
  approval: { risk: { external: 'approved' } },
  plugins: [guard],
})

const strictSession = agent.session('strict', { runtime: { judge: strictJudge } })
const strict = await strictSession.send('Email it.').result
console.log(`strict request: ${strict.stop}; outbox: [${outbox.join(', ')}]`)

const trustedSession = agent.session('trusted', { runtime: { trusted: true } })
const trusted = await trustedSession.send('Email it.').result
console.log(`trusted request: ${trusted.stop}; outbox: [${outbox.join(', ')}]`)
await agent.close()
