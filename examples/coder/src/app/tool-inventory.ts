/**
 * Size estimates of tool definitions for `/context`. The core reports one tool total; the
 * per-tool split comes from the definitions the app builds (own tools and the static tools its
 * plugins contribute), estimated like the core does: `10 + (name + description + JSON schema) / 4`.
 */
import { asSchema, type Tool } from 'ai'

/** `ceil(chars / 4)`, the core's default counter. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

const json = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

/** Estimated tokens of one tool definition. */
export async function estimateTool(name: string, tool: Tool): Promise<number> {
  let schema = ''
  try {
    const input = (tool as { inputSchema?: unknown }).inputSchema
    if (input !== undefined) {
      schema = json(await asSchema(input as Parameters<typeof asSchema>[0]).jsonSchema)
    }
  } catch {
    schema = ''
  }
  const description = typeof tool.description === 'string' ? tool.description : ''
  return 10 + estimateTokens(name) + estimateTokens(description) + estimateTokens(schema)
}

/**
 * A context that answers every property and call with another no-op proxy. Tool factories and
 * plugin session phases only read from it while *building* their tools, which is all we need to
 * measure the definitions (never to run them).
 */
function looseContext(): unknown {
  const noop: unknown = new Proxy(() => undefined, {
    get: (_t, key) => (key === 'then' ? undefined : noop),
    apply: () => undefined,
  })
  return noop
}

const isTool = (value: unknown): value is Tool => typeof value === 'object' && value !== null

/** Resolve a tool input (a tool, or a factory `(ctx) => tool`); `undefined` when it cannot be built. */
function build(input: unknown): Tool | undefined {
  try {
    const value =
      typeof input === 'function' ? (input as (ctx: unknown) => unknown)(looseContext()) : input
    return isTool(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** The tools of a record of tool inputs; entries that cannot be built are left out. */
export function buildTools(inputs: Record<string, unknown>): Record<string, Tool> {
  const out: Record<string, Tool> = {}
  for (const [name, input] of Object.entries(inputs)) {
    const built = build(input)
    if (built !== undefined) out[name] = built
  }
  return out
}

/**
 * The static tools a plugin contributes in its `setup` and `session` phases. Dynamic tool sources
 * (functions that need a live session) are skipped; a plugin whose phases need more than a no-op
 * context is not itemised.
 */
export async function pluginStaticTools(plugin: unknown): Promise<Record<string, Tool>> {
  const def = (
    plugin as {
      '~def'?: {
        name: string
        setup?: (ctx: unknown) => unknown
        session?: (ctx: unknown) => unknown
      }
    }
  )['~def']
  const out: Record<string, Tool> = {}
  const take = (contribution: unknown): void => {
    const tools = (contribution as { tools?: unknown } | undefined)?.tools
    if (tools !== null && typeof tools === 'object') {
      Object.assign(out, buildTools(tools as Record<string, unknown>))
    }
  }
  try {
    take(
      def?.setup?.({
        agentId: 'inventory',
        plugin: { name: def.name },
        has: { dataPart: () => false, service: () => false },
      }),
    )
  } catch {
    // not itemised
  }
  try {
    take(await def?.session?.(looseContext()))
  } catch {
    // not itemised
  }
  return out
}
