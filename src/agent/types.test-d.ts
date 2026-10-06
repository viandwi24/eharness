/**
 * Type-level tests, checked by `tsc --noEmit` (never executed).
 *
 * @see docs/engineering/testing.md#test-layers
 */
import { type InferUIMessageChunk, type LanguageModel, tool } from 'ai'
import { z } from 'zod/v4'
import {
  type ContextStats,
  defineDataPart,
  defineHarnessAgent,
  defineMessageKind,
  definePlugin,
  type HarnessUIMessage,
  type InferHarnessUIMessage,
  type KindName,
  type PendingState,
  type ToolRisk,
  type ToolTraits,
  type toolTraits,
} from '../index.ts'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T
type Extends<A, B> = [A] extends [B] ? true : false

declare const model: LanguageModel

type DataOf<M extends { parts: unknown[] }, T extends string> =
  Extract<M['parts'][number], { type: T }> extends { data: infer D } ? D : never
type PartTypes<M extends { parts: unknown[] }> = M['parts'][number] extends infer P
  ? P extends { type: infer T }
    ? T
    : never
  : never

const filesystem = definePlugin({
  name: 'filesystem',
  dataParts: {
    change: defineDataPart({
      schema: z.object({ path: z.string(), op: z.enum(['write', 'delete']) }),
    }),
    progress: defineDataPart({ schema: z.object({ done: z.number() }), transient: true }),
  },
  messageKinds: {
    report: defineMessageKind({ role: 'assistant', schema: z.object({ title: z.string() }) }),
  },
  session: (ctx) => {
    // ctx.stream.data accepts only this plugin's own keys, typed by their schema
    ctx.stream.data('change', { path: '/a.md', op: 'write' }, { id: '/a.md' })
    ctx.stream.data('progress', { done: 1 })
    // @ts-expect-error: not a key of this plugin
    ctx.stream.data('invoice', { total: 1 })
    // @ts-expect-error: namespaced type is not a local key
    ctx.stream.data('filesystem.change', { path: '/a.md', op: 'write' })
    // @ts-expect-error: wrong payload
    ctx.stream.data('change', { path: 1 })
    return {}
  },
})

const noParts = definePlugin({
  name: 'noparts',
  session: (ctx) => {
    // @ts-expect-error: a plugin without data parts cannot write any
    ctx.stream.data('change', {})
  },
})

const agent = defineHarnessAgent({
  model,
  tools: {
    get_price: tool({
      inputSchema: z.object({ symbol: z.string() }),
      execute: async ({ symbol }) => ({ symbol, price: 1 }),
    }),
  },
  dataParts: { invoice: defineDataPart({ schema: z.object({ total: z.number() }) }) },
  messageKinds: {
    reminder: defineMessageKind({ role: 'user', schema: z.object({ text: z.string() }) }),
  },
  plugins: [filesystem, noParts],
})

type AgentMessage = InferHarnessUIMessage<typeof agent>

// data part namespacing: plugin parts/kinds are `data-<plugin>.<key>`, app parts have no prefix
type _namespaced = Expect<
  Equal<DataOf<AgentMessage, 'data-filesystem.change'>, { path: string; op: 'write' | 'delete' }>
>
type _pluginKind = Expect<Equal<DataOf<AgentMessage, 'data-filesystem.report'>, { title: string }>>
type _appPart = Expect<Equal<DataOf<AgentMessage, 'data-invoice'>, { total: number }>>
type _appKind = Expect<Equal<DataOf<AgentMessage, 'data-reminder'>, { text: string }>>
// core parts are always included
type _core = Expect<Equal<DataOf<AgentMessage, 'data-eh.context'>, ContextStats>>
type _coreKind = Expect<Extends<'data-eh.compaction', PartTypes<AgentMessage>>>
// no un-namespaced plugin parts
type _noBareChange = Expect<Equal<Extends<'data-change', PartTypes<AgentMessage>>, false>>
// static app tools are typed
type _tool = Expect<Extends<'tool-get_price', PartTypes<AgentMessage>>>
type ToolPart = Extract<AgentMessage['parts'][number], { type: 'tool-get_price' }>
type _toolInput = Expect<
  Equal<Extract<ToolPart, { state: 'input-available' }>['input'], { symbol: string }>
>
// eharness metadata is typed
type _meta = Expect<Equal<NonNullable<NonNullable<AgentMessage['metadata']>['eharness']>['v'], 1>>

// an agent message is a HarnessUIMessage-compatible UIMessage and usable with chunk inference
type _chunk = Expect<
  Extends<{ type: 'data-invoice'; data: { total: number } }, InferUIMessageChunk<AgentMessage>>
>

// session kinds: inject accepts core, app and namespaced plugin kinds with typed payloads
type Kinds = typeof agent extends { '~types': { kinds: infer K } } ? K : never
type _kindNames = Expect<
  Equal<
    KindName<Kinds>,
    | 'eh.compaction'
    | 'eh.notice'
    | 'eh.event'
    | 'eh.rewind'
    | 'eh.flush'
    | 'reminder'
    | 'filesystem.report'
  >
>
declare const session: ReturnType<typeof agent.session>
void session.inject('eh.event', { name: 'deploy', text: 'done' })
void session.inject('filesystem.report', { title: 'Q3' })
// @ts-expect-error: data parts are not kinds
void session.inject('invoice', { total: 1 })
// @ts-expect-error: wrong payload
void session.inject('reminder', { title: 'x' })

// without plugins or tools: core parts only and any tool
const bare = defineHarnessAgent({ model })
type BareMessage = InferHarnessUIMessage<typeof bare>
type _bareCore = Expect<Extends<'data-eh.input', PartTypes<BareMessage>>>
type _bareTools = Expect<Extends<`tool-${string}`, PartTypes<BareMessage>>>
type _bareHarness = Expect<Extends<BareMessage, HarnessUIMessage>>

// InferHarnessUIMessage of something that is not an agent is never
type _notAgent = Expect<Equal<InferHarnessUIMessage<{ id: string }>, never>>

// ToolRisk (0.5.0) includes 'external'; a Record over it must name it
type _riskMembers = Expect<Equal<ToolRisk, 'read' | 'write' | 'destructive' | 'external'>>
// @ts-expect-error: 'external' is missing
const _riskRecord: Record<ToolRisk, number> = { read: 0, write: 1, destructive: 2 }
type _traitsRisk = Expect<Equal<ReturnType<typeof toolTraits>, ToolTraits>>
type _pendingRisk = Expect<
  Extends<'external', NonNullable<PendingState['approvals'][number]['risk']>>
>
type _pendingIdempotent = Expect<
  Equal<PendingState['approvals'][number]['idempotent'], boolean | undefined>
>
void defineHarnessAgent({ model, approval: { risk: { external: 'user-approval' } } })
