/**
 * `resolvePlugin`: resolve one plugin the way a session does, for unit tests of plugin code (the
 * tools it contributes, its hooks, its instructions) without opening a session, plus
 * `fakeHarnessContext`, the context those calls receive.
 *
 * Imports core only through `src/index.ts` (ADR-0008). The boot checks run through
 * `defineHarnessAgent`, so a plugin the core would refuse at boot is refused here with the same
 * error. The setup phase, the session phase, tool factories and instructions run with the same
 * context shape the core gives them.
 *
 * @see docs/engineering/testing.md#testing-a-plugin
 */
import type { ToolSet } from 'ai'
import {
  type AgentSetupContext,
  type DataPartMap,
  defineHarnessAgent,
  type HarnessContext,
  HarnessError,
  type HarnessHooks,
  type HarnessPlugin,
  type HookName,
  type InstructionInput,
  type PluginContribution,
  type SessionContribution,
  type ToolInput,
  type ToolSource,
} from '../index.ts'
import { scriptedModel } from './scripted-model.ts'

/** Overrides of the fake context: any field of {@link HarnessContext} may be replaced. */
export type HarnessContextOverrides<DP extends DataPartMap = Record<never, never>> = Partial<
  HarnessContext<DP>
>

/** One hook of {@link HarnessHooks}, by name. */
type HookFn<K extends HookName> = NonNullable<HarnessHooks[K]>

/** The arguments of a hook after its context. */
type HookExtra<K extends HookName> =
  HookFn<K> extends (ctx: never, ...rest: infer R) => unknown ? R : never

/** What a hook returns (awaited). */
export type HookResult<K extends HookName> = Awaited<ReturnType<HookFn<K>>>

/**
 * Arguments of {@link ResolvedPlugin.runHook} after the hook name: the event (required when the
 * hook takes one, `undefined` otherwise), then optional context overrides.
 */
export type RunHookArgs<K extends HookName> =
  HookExtra<K> extends [infer E, ...unknown[]]
    ? [event: E, ctx?: HarnessContextOverrides]
    : [event?: undefined, ctx?: HarnessContextOverrides]

// biome-ignore lint/suspicious/noExplicitAny: any plugin, whatever its data parts and message kinds
type AnyPlugin = HarnessPlugin<string, any, any>

/** Options of {@link resolvePlugin}. */
export interface ResolvePluginOptions {
  /**
   * Other plugins of the same agent. They boot with the plugin, so `requires` is satisfied by
   * their `provides` and the data parts they declare are known to `setup`.
   */
  plugins?: readonly AnyPlugin[]
  /** Services the context returns (`ctx.services.<name>`). Unknown names throw `EH_SERVICE_MISSING`. */
  services?: Readonly<Record<string, unknown>>
  /** Overrides of the context every tool factory, instruction and hook receives. */
  ctx?: HarnessContextOverrides
}

/** A plugin resolved for a session (see {@link resolvePlugin}). */
export interface ResolvedPlugin<DP extends DataPartMap = Record<never, never>> {
  readonly name: string
  /**
   * Tools by name, in order: the setup phase's, then the session phase's. `(ctx) => Tool`
   * factories are already called with {@link ResolvedPlugin.ctx}.
   */
  readonly tools: ToolSet
  /** Tool sources the plugin contributes. They are not opened. */
  readonly toolSources: readonly ToolSource[]
  /** Names of the hooks the plugin registers, setup phase first. */
  readonly hooks: readonly HookName[]
  /**
   * Instruction texts in order. Function instructions are evaluated with {@link ResolvedPlugin.ctx};
   * empty or `undefined` results are dropped.
   */
  readonly instructions: readonly string[]
  /** Services the session phase provided (`provides` must match, as in the core). */
  readonly services: Readonly<Record<string, unknown>>
  /** The context tool factories, instructions and hooks received by default. */
  readonly ctx: HarnessContext<DP>
  /**
   * Call the hook `name` the way the core does: `hook(ctx, event)`, with `ctx` the default context
   * merged with `overrides`. When the plugin registers the same hook in both phases, every
   * registration runs in order and the last result is returned. Resolves to `undefined` when the
   * plugin does not register `name`.
   */
  runHook<K extends HookName>(name: K, ...args: RunHookArgs<K>): Promise<HookResult<K>>
}

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} }

/** Services map of a fake context: a name no record entry provides throws `EH_SERVICE_MISSING`. */
function fakeServices(record: Readonly<Record<string, unknown>>): HarnessContext['services'] {
  return new Proxy({} as HarnessContext['services'], {
    get(_target, name) {
      if (typeof name !== 'string') return undefined
      if (Object.hasOwn(record, name)) return record[name]
      if (name === 'then' || name === 'toJSON') return undefined
      throw new HarnessError(
        'EH_SERVICE_MISSING',
        `Service '${name}' is not available to the fake context: pass it in \`services\`.`,
        { details: { service: name } },
      )
    },
    has(_target, name) {
      return typeof name === 'string' && Object.hasOwn(record, name)
    },
  })
}

/**
 * A fake `HarnessContext` for plugin `plugin`: no-op stream and logger, in-memory plugin state,
 * an aborted-never signal, no principal and no turn. Every field can be replaced with `overrides`
 * (for example `principal`, `session`, `runtime`, `stream`, `state`, `services`, `turn`).
 *
 * @example
 * ```ts
 * const ctx = fakeHarnessContext('audit', { principal: { id: 'ana' }, runtime: { trusted: true } })
 * ```
 */
export function fakeHarnessContext<DP extends DataPartMap = Record<never, never>>(
  plugin: string,
  overrides: HarnessContextOverrides<DP> = {},
): HarnessContext<DP> {
  const state = new Map<string, unknown>()
  const base: HarnessContext<DP> = {
    agent: { id: 'eh-test' },
    session: {
      id: 'eh-test-session',
      inject: () =>
        Promise.reject(new Error('fake context: session.inject is not wired; pass `session`.')),
    },
    plugin: { name: plugin },
    turn: undefined,
    step: undefined,
    observeModel: (model) => model,
    services: fakeServices({}),
    stream: {
      active: true,
      data() {},
      write() {},
    },
    state: {
      get(key) {
        return state.get(key) as never
      },
      set(key, value) {
        if (value === undefined) state.delete(key)
        else state.set(key, value)
      },
    },
    runtime: {},
    principal: undefined,
    log: quietLogger,
    signal: new AbortController().signal,
    warn() {},
  }
  return { ...base, ...overrides }
}

/** The entries of a `tools` contribution: records, tool sources or arrays of them. */
function toolEntries(
  tools: PluginContribution['tools'],
): Array<[name: string, input: ToolInput] | ToolSource> {
  if (tools === undefined) return []
  const list: unknown[] = Array.isArray(tools) ? tools : [tools]
  const out: Array<[string, ToolInput] | ToolSource> = []
  for (const entry of list) {
    if (isToolSourceValue(entry)) {
      out.push(entry)
      continue
    }
    for (const pair of Object.entries(entry as Record<string, ToolInput>)) out.push(pair)
  }
  return out
}

function isToolSourceValue(value: unknown): value is ToolSource {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { '~toolSource'?: unknown })['~toolSource'] === true
  )
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Resolve `plugin` for a session: boot checks (through `defineHarnessAgent`), the setup phase
 * (sync, with the agent setup context), the session phase (async, with the fake context), then
 * tool factories, instructions and hooks, in the order the core uses (setup before session).
 *
 * Session-phase contributions are not checked by the boot validation, as in the core; a
 * duplicate tool name between the two phases throws `EH_DUPLICATE_TOOL`.
 *
 * @example
 * ```ts
 * const resolved = await resolvePlugin(audit({ log }), { ctx: { principal: { id: 'ana' } } })
 * expect(Object.keys(resolved.tools)).toContain('read_file')
 * expect(await resolved.runHook('tool.approve', { toolName: 'rm', input: {} })).toEqual({ ... })
 * ```
 * @throws {HarnessError} the boot errors of `defineHarnessAgent` (`EH_SERVICE_MISSING`,
 *   `EH_PLUGIN_ORDER`, `EH_CONFIG_INVALID`, …), `EH_DUPLICATE_TOOL`, and `EH_CONFIG_INVALID` when
 *   a tool factory throws or returns no tool object.
 */
export async function resolvePlugin<DP extends DataPartMap = Record<never, never>>(
  // biome-ignore lint/suspicious/noExplicitAny: the message kinds do not matter to a resolution
  plugin: HarnessPlugin<string, DP, any>,
  options: ResolvePluginOptions = {},
): Promise<ResolvedPlugin<DP>> {
  if (typeof plugin !== 'object' || plugin === null || typeof plugin['~def'] !== 'object') {
    throw new TypeError('resolvePlugin: expected a plugin created with definePlugin().')
  }
  const others = options.plugins ?? []
  const all: readonly AnyPlugin[] = [...others, plugin]
  const name = plugin.name
  const def = plugin['~def']

  // boot checks: the same validation an agent runs over its plugins
  defineHarnessAgent({ model: scriptedModel([]), plugins: [...all] })

  // setup phase: the agent setup context, built from the plugins of the agent
  const provided = new Set(all.flatMap((p) => p['~def'].provides ?? []))
  const dataParts = new Set(
    all.flatMap((p) =>
      Object.keys(p['~def'].dataParts ?? {}).map((key) => `data-${p.name}.${key}`),
    ),
  )
  const setupCtx: AgentSetupContext = {
    agentId: 'eh-test',
    plugin: { name },
    has: {
      dataPart: (type) => dataParts.has(type),
      service: (service) => provided.has(service),
    },
  }
  const contributions: PluginContribution[] = []
  if (def.setup !== undefined) {
    const result: unknown = def.setup.call(def, setupCtx)
    if (typeof result === 'object' && result !== null) {
      contributions.push(result as PluginContribution)
    }
  }

  // session phase: async, with the fake context the core would give this plugin
  const ctx = fakeHarnessContext<DP>(name, {
    services: fakeServices(options.services ?? {}),
    ...options.ctx,
  })
  let services: Record<string, unknown> = {}
  if (def.session !== undefined) {
    const result: unknown = await def.session.call(def, ctx)
    if (typeof result === 'object' && result !== null) {
      const session = result as SessionContribution<DP>
      contributions.push(session)
      services = { ...(session.services as Record<string, unknown> | undefined) }
    }
  }

  // tools: factories resolved with the same context as the hooks
  const tools = new Map<string, ToolSet[string]>()
  const toolSources: ToolSource[] = []
  for (const contribution of contributions) {
    for (const entry of toolEntries(contribution.tools)) {
      if (!Array.isArray(entry)) {
        toolSources.push(entry)
        continue
      }
      const [toolName, input] = entry
      if (tools.has(toolName)) {
        throw new HarnessError(
          'EH_DUPLICATE_TOOL',
          `Tool '${toolName}' is declared twice by plugin '${name}'.`,
          { details: { tool: toolName, owners: [name, name] } },
        )
      }
      tools.set(toolName, resolveTool(name, toolName, input, ctx))
    }
  }

  // instructions: text, or functions evaluated with the context
  const instructions: string[] = []
  for (const contribution of contributions) {
    for (const entry of instructionList(contribution.instructions)) {
      const value = await instructionText(entry, ctx)
      if (value !== undefined && value !== '') instructions.push(value)
    }
  }

  // hooks: setup phase first, then session phase
  const hookEntries: Array<[HookName, (...args: unknown[]) => unknown]> = []
  for (const contribution of contributions) {
    for (const [hookName, fn] of Object.entries(contribution.hooks ?? {})) {
      hookEntries.push([hookName as HookName, fn as (...args: unknown[]) => unknown])
    }
  }
  const hookNames = [...new Set(hookEntries.map(([hookName]) => hookName))]

  const runHook = async <K extends HookName>(
    hookName: K,
    ...args: RunHookArgs<K>
  ): Promise<HookResult<K>> => {
    const [event, overrides] = args as unknown as [unknown, HarnessContextOverrides | undefined]
    const hookCtx = overrides === undefined ? ctx : { ...ctx, ...overrides }
    let last: unknown
    for (const [registered, fn] of hookEntries) {
      if (registered !== hookName) continue
      // called without `this`, as the core calls hook functions
      last = await fn(hookCtx, event)
    }
    return last as HookResult<K>
  }

  return {
    name,
    tools: Object.fromEntries(tools) as ToolSet,
    toolSources,
    hooks: hookNames,
    instructions,
    services: Object.freeze(services),
    ctx,
    runHook,
  }
}

function resolveTool(
  owner: string,
  toolName: string,
  input: ToolInput,
  ctx: HarnessContext,
): ToolSet[string] {
  if (typeof input !== 'function') return input
  let tool: unknown
  try {
    tool = input(ctx)
  } catch (error) {
    throw new HarnessError(
      'EH_CONFIG_INVALID',
      `plugin '${owner}': tool '${toolName}' factory threw: ${errorText(error)}`,
      { details: { owner, tool: toolName }, cause: error },
    )
  }
  if (typeof tool !== 'object' || tool === null) {
    throw new HarnessError(
      'EH_CONFIG_INVALID',
      `plugin '${owner}': tool '${toolName}' factory must return an AI SDK tool.`,
      { details: { owner, tool: toolName } },
    )
  }
  return tool as ToolSet[string]
}

function instructionList(
  input: InstructionInput | InstructionInput[] | undefined,
): InstructionInput[] {
  if (input === undefined) return []
  return Array.isArray(input) ? input : [input]
}

async function instructionText(
  entry: InstructionInput,
  ctx: HarnessContext,
): Promise<string | undefined> {
  if (typeof entry === 'string') return entry
  if (typeof entry === 'function') return entry(ctx)
  const text = entry.text
  if (typeof text === 'string') return text
  return text(ctx)
}
