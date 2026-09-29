/**
 * `defineHarnessAgent`: config normalization, plugin composition and boot validation.
 *
 * @see docs/specs/01-agent-and-plugins.md
 * @see docs/architecture.md#31-boot--defineharnessagentconfig-synchronous-no-io
 */
import { createWarningEmitter, HarnessError, isHarnessError } from '../errors.ts'
import { createUuidV7Generator } from '../messages/ids.ts'
import { createCoreMessageRegistry } from '../messages/registry.ts'
import {
  isHarnessPlugin,
  PLUGIN_NAME_PATTERN,
  RESERVED_PLUGIN_NAMES,
  validatePartMaps,
} from '../plugin/define-plugin.ts'
import type {
  AgentSetupContext,
  DataPartMap,
  HarnessPlugin,
  KindMap,
  PluginContribution,
} from '../plugin/types.ts'
import { addContribution, createStaticRegistry, describeOwner } from '../registry/static.ts'
import { isToolSource } from '../registry/tool-source.ts'
import type { ToolsInput } from '../registry/types.ts'
import { type AgentInternals, setAgentInternals } from './internals.ts'
import { type AgentSessions, createAgentSessions } from './sessions.ts'
import type { AgentKindTypes, AgentMessageOf, HarnessAgent, HarnessAgentConfig } from './types.ts'

type AnyPlugin = HarnessPlugin<string, DataPartMap, KindMap>

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new HarnessError(
    'EH_CONFIG_INVALID',
    message,
    details === undefined ? undefined : { details },
  )
}

/** True for anything AI SDK accepts as a `FlexibleSchema` (zod, Standard Schema, `jsonSchema()`, lazy). */
function isSchemaLike(value: unknown): boolean {
  if (typeof value === 'function') return true // lazySchema
  if (typeof value !== 'object' || value === null) return false
  return (
    '~standard' in value || // Standard Schema (zod ≥ 3.24, valibot, arktype, …)
    '_zod' in value || // zod 4
    '_def' in value || // zod 3
    ('jsonSchema' in value && 'validate' in value) // AI SDK Schema
  )
}

function validateConfig(config: HarnessAgentConfig): void {
  if (typeof config !== 'object' || config === null) {
    invalid('defineHarnessAgent: expected a configuration object.')
  }
  if (config.model === undefined || config.model === null || config.model === '') {
    invalid('defineHarnessAgent: `model` is required.')
  }
  if (config.id !== undefined && (typeof config.id !== 'string' || config.id.length === 0)) {
    invalid('defineHarnessAgent: `id` must be a non-empty string.')
  }
  if (config.callOptions !== undefined && !isSchemaLike(config.callOptions)) {
    invalid(
      'defineHarnessAgent: `callOptions` must be a schema (zod, Standard Schema or jsonSchema()).',
    )
  }
  const timeout = config.settings?.timeout
  if (typeof timeout === 'object' && timeout !== null && 'totalMs' in timeout) {
    invalid(
      'defineHarnessAgent: `settings.timeout.totalMs` is not supported (one streamText call per step); use `loop.turnTimeoutMs`.',
    )
  }
  const window = config.contextWindow
  if (
    window !== undefined &&
    typeof window !== 'function' &&
    !(typeof window === 'number' && Number.isFinite(window) && window > 0)
  ) {
    invalid('defineHarnessAgent: `contextWindow` must be a positive number or a function.')
  }
  if (config.mcp !== undefined) {
    if (!Array.isArray(config.mcp) || !config.mcp.every(isToolSource)) {
      invalid('defineHarnessAgent: `mcp` must be an array of tool sources (e.g. mcpServer(...)).')
    }
  }
  validatePartMaps('the app (agent config)', config.dataParts, config.messageKinds)
}

function orderPlugins(config: HarnessAgentConfig): AnyPlugin[] {
  const root: AnyPlugin = {
    name: 'app',
    '~def': {
      name: 'app',
      ...(config.dataParts === undefined ? {} : { dataParts: config.dataParts }),
      ...(config.messageKinds === undefined ? {} : { messageKinds: config.messageKinds }),
    },
  }
  const plugins = config.plugins ?? []
  if (!Array.isArray(plugins)) invalid('defineHarnessAgent: `plugins` must be an array.')
  const seen = new Map<string, number>()
  for (const [index, plugin] of plugins.entries()) {
    if (!isHarnessPlugin(plugin)) {
      invalid(`defineHarnessAgent: plugins[${index}] is not a plugin (use definePlugin()).`)
    }
    const name = plugin.name
    if (!PLUGIN_NAME_PATTERN.test(name) || RESERVED_PLUGIN_NAMES.includes(name)) {
      invalid(`Plugin name '${name}' (plugins[${index}]) is invalid or reserved.`, { plugin: name })
    }
    const previous = seen.get(name)
    if (previous !== undefined) {
      invalid(
        `Plugin '${name}' is registered twice (plugins[${previous}] and plugins[${index}]).`,
        { plugin: name, positions: [previous, index] },
      )
    }
    seen.set(name, index)
  }
  return [root, ...plugins]
}

function rootContribution(config: HarnessAgentConfig): PluginContribution {
  const tools: Array<Exclude<ToolsInput, unknown[]>> = []
  if (config.tools !== undefined) {
    if (Array.isArray(config.tools)) tools.push(...config.tools)
    else tools.push(config.tools)
  }
  if (config.mcp !== undefined) tools.push(...config.mcp)
  const contribution: PluginContribution = { tools }
  if (config.instructions !== undefined) contribution.instructions = config.instructions
  if (config.skills !== undefined) contribution.skills = config.skills
  return contribution
}

/**
 * Define an agent: configuration + plugins. Synchronous and pure (no I/O).
 *
 * Normalizes the config (top-level `instructions`/`tools`/`skills`/`mcp`/`dataParts`/
 * `messageKinds` become the root plugin `app`), runs every plugin's `setup` in order
 * (`[app, ...plugins]`), builds the static registries and validates them.
 *
 * @example
 * ```ts
 * export const agent = defineHarnessAgent({
 *   model: 'anthropic/claude-sonnet-4.6',
 *   instructions: 'You write and review Pine Script v6 strategies.',
 *   tools: { get_price: tool({ … }) },
 *   plugins: [filesystem({ fs: memoryFs() })],
 * })
 * ```
 * @throws {HarnessError} on every boot conflict of spec 01 §7: `EH_CONFIG_INVALID`,
 *   `EH_DUPLICATE_TOOL`, `EH_DUPLICATE_SKILL`, `EH_DUPLICATE_DATA_PART`, `EH_SERVICE_CONFLICT`,
 *   `EH_SERVICE_MISSING`, `EH_PLUGIN_ORDER`. Messages name every involved owner.
 * @see docs/specs/01-agent-and-plugins.md#1-defineharnessagent
 */
export function defineHarnessAgent<const C extends HarnessAgentConfig>(config: C): HarnessAgent<C> {
  validateConfig(config)
  const id = config.id ?? 'agent'
  const plugins = orderPlugins(config)

  // data parts and kinds: core, then plugins in order (root first)
  const messages = createCoreMessageRegistry()
  for (const plugin of plugins) {
    const def = plugin['~def']
    const prefix = plugin.name === 'app' ? '' : `${plugin.name}.`
    for (const [key, part] of Object.entries(def.dataParts ?? {})) {
      messages.registerDataPart(`${prefix}${key}`, part, plugin.name)
    }
    for (const [key, kind] of Object.entries(def.messageKinds ?? {})) {
      messages.registerKind(`${prefix}${key}`, kind, plugin.name)
    }
  }

  // services: one provider per name; requirers after their provider
  const providers = new Map<string, { plugin: string; index: number }>()
  for (const [index, plugin] of plugins.entries()) {
    for (const service of plugin['~def'].provides ?? []) {
      const existing = providers.get(service)
      if (existing !== undefined && existing.plugin !== plugin.name) {
        throw new HarnessError(
          'EH_SERVICE_CONFLICT',
          `Service '${service}' is provided by two plugins: '${existing.plugin}' and '${plugin.name}'.`,
          { details: { service, plugins: [existing.plugin, plugin.name] } },
        )
      }
      providers.set(service, { plugin: plugin.name, index })
    }
  }
  for (const [index, plugin] of plugins.entries()) {
    for (const service of plugin['~def'].requires ?? []) {
      const provider = providers.get(service)
      if (provider === undefined) {
        throw new HarnessError(
          'EH_SERVICE_MISSING',
          `Plugin '${plugin.name}' requires service '${service}', but no plugin provides it.`,
          { details: { service, plugin: plugin.name } },
        )
      }
      if (provider.index > index) {
        throw new HarnessError(
          'EH_PLUGIN_ORDER',
          `Plugin '${plugin.name}' requires service '${service}' from plugin '${provider.plugin}', which is ordered after it. Move '${provider.plugin}' before '${plugin.name}' in \`plugins\`.`,
          { details: { service, plugin: plugin.name, provider: provider.plugin } },
        )
      }
    }
  }

  // setup phase (sync, pure) → static registries
  const statics = createStaticRegistry()
  for (const plugin of plugins) {
    let contribution: PluginContribution | undefined
    if (plugin.name === 'app') {
      contribution = rootContribution(config)
    } else {
      const setup = plugin['~def'].setup
      if (setup === undefined) continue
      const ctx: AgentSetupContext = {
        agentId: id,
        plugin: { name: plugin.name },
        has: {
          dataPart: (type) => type.startsWith('data-') && messages.dataPart(type) !== undefined,
          service: (name) => providers.has(name),
        },
      }
      let result: unknown
      try {
        result = setup.call(plugin['~def'], ctx)
      } catch (error) {
        if (isHarnessError(error)) throw error
        throw new HarnessError(
          'EH_CONFIG_INVALID',
          `${describeOwner(plugin.name)}: setup() threw: ${error instanceof Error ? error.message : String(error)}`,
          { details: { owner: plugin.name }, cause: error },
        )
      }
      if (
        typeof result === 'object' &&
        result !== null &&
        typeof (result as { then?: unknown }).then === 'function'
      ) {
        invalid(
          `${describeOwner(plugin.name)}: setup() must be synchronous; use session() for async work.`,
          { owner: plugin.name },
        )
      }
      if (result === undefined) continue
      if (typeof result !== 'object' || result === null) {
        invalid(
          `${describeOwner(plugin.name)}: setup() must return a contribution object or nothing.`,
        )
      }
      contribution = result as PluginContribution
    }
    addContribution(statics, plugin.name, contribution)
  }

  const custom = config.generateId
  const uuid = createUuidV7Generator()
  const internals: AgentInternals = {
    id,
    config,
    plugins,
    messages,
    services: new Map([...providers].map(([service, p]) => [service, p.plugin])),
    statics,
    emitWarning: createWarningEmitter({
      ...(config.onWarning === undefined ? {} : { onWarning: config.onWarning }),
      ...(config.strict === undefined ? {} : { strict: config.strict }),
    }),
    generateId: custom === undefined ? uuid : () => custom(),
  }
  // the session cache is created on first use (defineHarnessAgent does no I/O and no timers)
  let sessions: AgentSessions | undefined
  const runtime = (): AgentSessions => {
    sessions ??= createAgentSessions(internals)
    return sessions
  }
  const agent: HarnessAgent<C> = {
    id,
    config: Object.freeze({ ...config }),
    session: (sessionId, options) =>
      runtime().session(sessionId, options) as unknown as ReturnType<HarnessAgent<C>['session']>,
    closeSession: (sessionId) => runtime().closeSession(sessionId),
    close: () => runtime().close(),
    '~types': undefined as unknown as { message: AgentMessageOf<C>; kinds: AgentKindTypes<C> },
  }
  setAgentInternals(agent, internals)
  return agent
}
