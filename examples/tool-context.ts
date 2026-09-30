// A tool that reads the running chat (session, turn input, runtime values, state) and writes
// custom data parts into the live UI stream. `bun examples/tool-context.ts` runs it offline.
import { tool } from 'ai'
import { defineDataPart, defineHarnessAgent } from 'eharness'
import { z } from 'zod/v4'
import { exampleModel } from './shared/model.ts'

const model = exampleModel([
  { toolCalls: [{ toolName: 'create_invoice', input: { total: 120 } }] },
  { text: 'Invoice sent.' },
])

const agent = defineHarnessAgent({
  model,
  contextWindow: 200_000,
  dataParts: {
    // stored in the assistant message; the same `id` updates it in place
    invoice: defineDataPart({ schema: z.object({ total: z.number(), status: z.string() }) }),
    // streamed only, never stored (progress, spinners)
    progress: defineDataPart({ schema: z.object({ percent: z.number() }), transient: true }),
  },
  tools: {
    // a function `(ctx) => tool()` receives the session context
    create_invoice: (ctx) =>
      tool({
        description: 'Create and send an invoice',
        inputSchema: z.object({ total: z.number() }),
        // AI SDK's second argument: this call's id, the model messages so far, the abort signal
        execute: async ({ total }, { toolCallId, messages, abortSignal }) => {
          const userText = ctx.turn?.input?.parts.find((p) => p.type === 'text')?.text
          const userId = String(ctx.runtime.userId) // from agent.session(id, { runtime }) / send()
          const count = (ctx.state.get<number>('invoices') ?? 0) + 1
          ctx.state.set('invoices', count) // persisted with the session

          ctx.stream.data('progress', { percent: 50 }) // names and payloads are type-checked
          ctx.stream.data('invoice', { total, status: 'draft' }, { id: toolCallId })
          if (abortSignal?.aborted) return 'Cancelled.'
          ctx.stream.data('invoice', { total, status: 'sent' }, { id: toolCallId })

          return `Invoice #${count} for ${userId} in session ${ctx.session.id} (${messages.length} messages so far, request: "${userText}")`
        },
      }),
  },
})

const session = agent.session('chat-1', { runtime: { userId: 'u_42' } })
const run = session.send('Invoice 120 for me')
for await (const chunk of run.stream) {
  if (chunk.type === 'data-progress') console.log(`progress ${chunk.data.percent}%`)
  if (chunk.type === 'data-invoice') console.log(`invoice ${chunk.data.status}`)
}
const result = await run.result

const [, assistant] = await session.messages()
const stored = assistant?.parts.filter((p) => p.type === 'data-invoice') ?? []
const output = assistant?.parts.find((p) => p.type === 'tool-create_invoice')
console.log(`${result.stop}: ${stored.length} invoice part stored`)
if (output && 'output' in output) console.log(String(output.output))

await agent.close()
