/**
 * Type-level tests of `eharness/mcp` (0.8), checked by `tsc --noEmit` (never executed).
 *
 * @see docs/engineering/testing.md#test-layers
 */
import type { ToolSource } from '../index.ts'
import { type McpServerSourceOptions, mcpServerSource, type remoteMcpSource } from './index.ts'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

const stdio = mcpServerSource({
  name: 'github',
  transport: { type: 'http', url: 'https://mcp.example.com' },
  allow: ['read'],
  defer: 'auto',
  connect: 'eager',
})
type _Source = Expect<Equal<typeof stdio, ToolSource>>

// the transport may be a per-session resolver that receives the context
mcpServerSource({
  name: 'tenant',
  transport: async (ctx) => {
    type _Ctx = Expect<
      Equal<
        typeof ctx,
        Parameters<Extract<McpServerSourceOptions['transport'], (...a: never[]) => unknown>>[0]
      >
    >
    return { type: 'sse', url: 'https://mcp.example.com/sse' }
  },
})

// @ts-expect-error: name and transport are required
mcpServerSource({})
mcpServerSource({
  name: 'x',
  transport: { type: 'http', url: 'u' },
  // @ts-expect-error: defer is a boolean or 'auto'
  defer: 'sometimes',
})
mcpServerSource({
  name: 'x',
  transport: { type: 'http', url: 'u' },
  // @ts-expect-error: connect is 'lazy' or 'eager'
  connect: 'never',
})

type _Remote = Expect<Equal<ReturnType<typeof remoteMcpSource>, ToolSource>>
