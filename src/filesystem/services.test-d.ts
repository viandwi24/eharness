/**
 * Type tests: importing `eharness/filesystem` types `ctx.services.fs` / `ctx.services.toolOutputs`
 * (declaration merging, spec 01 §6) and the `data-filesystem.change` part.
 */
import {
  defineHarnessAgent,
  definePlugin,
  type HarnessContext,
  type InferHarnessUIMessage,
} from '../index.ts'
import type { FileChangeData, FileSystem, ToolOutputStore } from './index.ts'
import { filesystem } from './index.ts'
import { memoryFs } from './memory.ts'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

type _fs = Expect<Equal<HarnessContext['services']['fs'], FileSystem>>
type _outputs = Expect<Equal<HarnessContext['services']['toolOutputs'], ToolOutputStore>>

definePlugin({
  name: 'reader',
  requires: ['fs'],
  session: async (ctx) => {
    const entry = await ctx.services.fs.read('/a.md')
    const _content: string | undefined = entry?.content
    // @ts-expect-error FileSystem has no `readdir`
    ctx.services.fs.readdir('/')
  },
})

const agent = defineHarnessAgent({
  model: 'openai/gpt-5',
  plugins: [filesystem({ fs: memoryFs() })],
})
type AgentMessage = InferHarnessUIMessage<typeof agent>
type DataOf<M, T> = M extends { parts: Array<infer P> }
  ? P extends { type: T; data: infer D }
    ? D
    : never
  : never
type _change = Expect<Equal<DataOf<AgentMessage, 'data-filesystem.change'>, FileChangeData>>

// the resolver form receives the session context
filesystem({ fs: (ctx: HarnessContext) => (ctx.session.id === 'a' ? memoryFs() : memoryFs()) })
// @ts-expect-error unknown tool name
filesystem({ fs: memoryFs(), tools: ['rm'] })
