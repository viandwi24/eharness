/**
 * Type-level tests of plugin assignability (`definePlugin` results), checked by `tsc --noEmit`
 * (never executed). They pin three guarantees: a plugin assigns to a `HarnessPlugin` variable
 * (default params), a mixed array of plugins assigns to every option that takes plugins, and
 * the agent's message type still reads each plugin's own data parts and kinds.
 *
 * @see docs/specs/01-agent-and-plugins.md#2-defineplugin
 * @see docs/engineering/testing.md#test-layers
 */
import type { LanguageModel, UIMessage } from 'ai'
import { z } from 'zod/v4'
import {
  type DataPartMap,
  defineDataPart,
  defineHarnessAgent,
  defineMessageKind,
  definePlugin,
  type HarnessPlugin,
  type InferHarnessUIMessage,
  type KindMap,
  wrapPlugin,
} from '../index.ts'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
const assert = <_T extends true>(): void => {}

declare const model: LanguageModel

const alpha = definePlugin({
  name: 'alpha',
  dataParts: { note: defineDataPart({ schema: z.object({ text: z.string() }) }) },
  setup: () => ({
    hooks: {
      'tool.after': (ctx) => {
        ctx.stream.data('note', { text: 'x' })
      },
    },
  }),
})

const beta = definePlugin({
  name: 'beta',
  dataParts: { count: defineDataPart({ schema: z.object({ n: z.number() }) }) },
  messageKinds: {
    rem: defineMessageKind({
      role: 'user',
      schema: z.object({ n: z.number() }),
      model: (d) => String(d.n),
    }),
  },
})

const gamma = definePlugin({
  name: 'gamma',
  setup: () => ({
    hooks: {
      'tool.approve': (_ctx, e) => {
        if (e.toolName === 'x') return { type: 'user-approval', reason: 'r' }
      },
    },
  }),
})

// (a) any definePlugin result assigns to a HarnessPlugin variable (default params)
const aDefault: HarnessPlugin = alpha
const bDefault: HarnessPlugin = beta
const gDefault: HarnessPlugin = gamma
function factory(): HarnessPlugin<'factory'> {
  return definePlugin({ name: 'factory', dataParts: { x: defineDataPart({ schema: z.string() }) } })
}
const fDefault: HarnessPlugin = factory()
void aDefault
void bDefault
void gDefault
void fDefault

// (b) a mixed array assigns to the agent's `plugins` option and to the other plugin options
const mixed: HarnessPlugin[] = [alpha, beta, gamma]
const agent = defineHarnessAgent({ model, plugins: [alpha, beta, gamma] })
const agentFromList = defineHarnessAgent({ model, plugins: mixed })
const wrapped = wrapPlugin(alpha, {
  session: (_ctx, next) => next.using(beta),
})
const wrappedDefault: HarnessPlugin = wrapped
void mixed
void agentFromList
void wrappedDefault

// (c) inference from `plugins` still yields each plugin's own data parts and kinds
type Message = InferHarnessUIMessage<typeof agent>
type Data = Message extends UIMessage<infer _M, infer D, infer _T> ? D : never
assert<Equal<Data['alpha.note'], { text: string }>>()
assert<Equal<Data['beta.count'], { n: number }>>()
assert<Equal<Data['beta.rem'], { n: number }>>()
assert<Equal<'beta.missing' extends keyof Data ? true : false, false>>()

const solo = defineHarnessAgent({ model, plugins: [alpha] })
type SoloData =
  InferHarnessUIMessage<typeof solo> extends UIMessage<infer _M, infer D, infer _T> ? D : never
assert<Equal<SoloData['alpha.note'], Data['alpha.note']>>()

// the typed stream writer still rejects unknown parts of the plugin's own data parts
const typed = definePlugin({
  name: 'typed',
  dataParts: { note: defineDataPart({ schema: z.object({ text: z.string() }) }) },
  setup: () => ({
    hooks: {
      'tool.after': (ctx) => {
        // @ts-expect-error unknown data part of this plugin
        ctx.stream.data('missing', { text: 'x' })
      },
    },
  }),
})
const typedDefault: HarnessPlugin = typed
void typedDefault

// kinds and parts of an accepted-as-HarnessPlugin value are still checked on the way in
const badKinds: KindMap = {}
const badParts: DataPartMap = {}
void badKinds
void badParts
