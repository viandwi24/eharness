/**
 * Type tests: tool factories (`(ctx) => tool(…)`) get a context typed with the data parts of
 * their owner — the plugin's `dataParts`, or the app's `dataParts` for top-level tools.
 * Checked by `tsc --noEmit` (never executed).
 *
 * @see docs/specs/04-streaming.md#3-plugin-stream-writer
 */
import { type LanguageModel, tool } from 'ai'
import { z } from 'zod/v4'
import {
  defineDataPart,
  defineHarnessAgent,
  definePlugin,
  type HarnessAgentConfig,
  type InferHarnessUIMessage,
} from '../index.ts'

declare const model: LanguageModel

const input = z.object({})

// plugin: tools contributed from session() and setup()
definePlugin({
  name: 'invoices',
  dataParts: { invoice: defineDataPart({ schema: z.object({ total: z.number() }) }) },
  setup: () => ({
    tools: {
      from_setup: (ctx) =>
        tool({
          inputSchema: input,
          execute: async () => {
            ctx.stream.data('invoice', { total: 1 }, { id: 'a' })
            // @ts-expect-error: not a part of this plugin
            ctx.stream.data('receipt', { total: 1 })
            // @ts-expect-error: wrong payload
            ctx.stream.data('invoice', { total: 'one' })
            return 'ok'
          },
        }),
    },
  }),
  session: () => ({
    tools: [
      {
        from_session: (ctx) =>
          tool({
            inputSchema: input,
            execute: async () => {
              ctx.stream.data('invoice', { total: 2 })
              // @ts-expect-error: namespaced type is not a local key
              ctx.stream.data('invoices.invoice', { total: 2 })
              return 'ok'
            },
          }),
      },
    ],
  }),
})

// app: top-level tool factories see the app's dataParts
const agent = defineHarnessAgent({
  model,
  dataParts: {
    invoice: defineDataPart({ schema: z.object({ total: z.number() }) }),
    progress: defineDataPart({ schema: z.object({ percent: z.number() }), transient: true }),
  },
  tools: {
    create_invoice: (ctx) =>
      tool({
        inputSchema: z.object({ total: z.number() }),
        execute: async ({ total }) => {
          ctx.stream.data('progress', { percent: 50 })
          ctx.stream.data('invoice', { total }, { id: 'inv-1' })
          // @ts-expect-error: not an app part
          ctx.stream.data('receipt', { total })
          // @ts-expect-error: wrong payload
          ctx.stream.data('progress', { percent: 'half' })
          return 'sent'
        },
      }),
  },
})

// the inferred message type is unchanged: app parts and the static tool are typed
type Message = InferHarnessUIMessage<typeof agent>
type PartTypes = Message['parts'][number]['type']
const _invoice: PartTypes = 'data-invoice'
const _tool: PartTypes = 'tool-create_invoice'
void _invoice
void _tool

// an agent without dataParts: tool factories may not write unknown parts
defineHarnessAgent({
  model,
  tools: {
    t: (ctx) =>
      tool({
        inputSchema: input,
        execute: async () => {
          // @ts-expect-error: the app declares no data parts
          ctx.stream.data('invoice', { total: 1 })
          ctx.stream.write({ type: 'data-invoice', data: { total: 1 } })
          return 'ok'
        },
      }),
  },
})

// a config typed with the (non-generic) HarnessAgentConfig still works
declare const config: HarnessAgentConfig
defineHarnessAgent(config)
