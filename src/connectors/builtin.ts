/**
 * Built-in connectors: the shipped plugins (files, memory, planning, web, ask, team) as
 * connector definitions with capabilities an app can relabel. The module imports no plugin
 * (dogfooding rule): the app passes the factories that need its wiring (file system, memory
 * paths, search backend, subagent catalog).
 *
 * @see docs/specs/24-connectors.md#8-built-in-connectors
 */
import { defineConnector } from './definition.ts'
import type {
  CapabilityDef,
  CapabilityMode,
  ConnectionRecord,
  ConnectionStore,
  ConnectorActivation,
  ConnectorActivationContext,
  ConnectorDefinition,
  ConnectorScope,
  ResolvedCapability,
} from './types.ts'

/** Ids of the built-in connectors. */
export type BuiltinId = 'files' | 'memory' | 'planning' | 'web' | 'ask' | 'team'

/** Tool names of the built-in connectors (the names the shipped plugins register). */
export const BUILTIN_TOOLS = {
  filesRead: ['read_file', 'list_files', 'grep', 'glob'],
  filesEdit: ['write_file', 'edit_file'],
  filesDelete: ['delete_file'],
  memoryRead: ['memory_view'],
  memoryWrite: [
    'memory_create',
    'memory_str_replace',
    'memory_insert',
    'memory_delete',
    'memory_rename',
  ],
  planning: ['todo_write'],
  webSearch: ['web_search'],
  webRead: ['web_fetch'],
  ask: ['ask_user_question'],
  teamDelegate: ['agent', 'agent_output', 'agent_stop'],
  teamMessage: ['send_message'],
} as const

/** Text an app may replace for one capability. */
export interface BuiltinCapabilityLabel {
  title?: string
  description?: string
}

/** What an app may relabel on one built-in connector. */
export interface BuiltinLabel {
  name?: string
  description?: string
  icon?: string
  category?: string
  /** Static instruction block. */
  instructions?: string
  /** Capability id to text. */
  capabilities?: Record<string, BuiltinCapabilityLabel>
  /** Default connection labels per scope ("Workspace memory"). */
  scopeLabels?: Partial<Record<ConnectorScope, string>>
}

/** What a built-in plugin factory is told. */
export interface BuiltinInput {
  /** The tool names that are not `off`. */
  tools: string[]
  /** Mode of every capability. */
  modes: Record<string, CapabilityMode>
  /** The capabilities that are not `off`. */
  capabilities: ResolvedCapability[]
}

/** Builds the plugin(s) of one built-in connector. */
export type BuiltinFactory = (
  input: BuiltinInput,
  ctx: ConnectorActivationContext,
) => ConnectorActivation | Promise<ConnectorActivation>

/** One memory root the memory connector derived from its connections. */
export interface BuiltinMemoryRoot {
  /** Directory of the root. */
  path: string
  /** Writable (the connection's write capability is on). */
  write: boolean
  /** Shown to the model (the connection label). */
  label: string
  scope: ConnectorScope
  connectionId: string
}

/** Options of {@link builtinConnectors}. Only the built-ins whose factory is given are returned. */
export interface BuiltinConnectorsOptions {
  labels?: Partial<Record<BuiltinId, BuiltinLabel>>
  /** `filesystem({ fs, tools: input.tools })`. */
  files?: { plugin: BuiltinFactory }
  /**
   * Memory: where each scope lives and how to build the plugin from the roots, for example
   * `plugin: (roots) => memory({ roots: () => roots.map(({ path, write, label }) => ({ path, write, label })) })`.
   * `workspace` memory is shared by the whole team, `agent` memory is private to one agent.
   * The memory plugin offers all its tools whenever a root is writable or readable; use the
   * capability modes (rules) to restrict them.
   */
  memory?: {
    paths: { workspace: string; agent: (agentId: string) => string }
    plugin: (
      roots: BuiltinMemoryRoot[],
      input: BuiltinInput,
    ) => ConnectorActivation | Promise<ConnectorActivation>
  }
  /** `todos()`. */
  planning?: { plugin: BuiltinFactory }
  /** `webSearch({ search })` and `webFetch()`; a capability exists only when its factory is given. */
  web?: { search?: BuiltinFactory; read?: BuiltinFactory }
  /** `askUser()`. */
  ask?: { plugin: BuiltinFactory }
  /** `subagents({ agents })`: delegate work and message agents (one plugin). */
  team?: { plugin: BuiltinFactory }
}

function cap(
  id: string,
  title: string,
  description: string,
  kind: CapabilityDef['kind'],
  tools: readonly string[],
  label?: BuiltinCapabilityLabel,
): CapabilityDef {
  return {
    id,
    title: label?.title ?? title,
    description: label?.description ?? description,
    kind,
    tools: [...tools],
    // built-in tools stay governed by the app's permission mode: `allow` adds no rule
    defaultMode: 'allow',
  }
}

const inputOf = (ctx: ConnectorActivationContext): BuiltinInput => ({
  tools: ctx.tools,
  modes: ctx.modes,
  capabilities: ctx.capabilities,
})

/**
 * The built-in connector definitions for the factories the app supplies. Built-in capabilities
 * default to `allow`, which adds no rule (the app's permission mode decides: reading is free,
 * writing asks in `default` mode); `ask` adds an ask rule, `off` a deny rule. Built-in tools are
 * never pinned (spec 24 §7): `bypassPermissions` skips their asks like any other built-in tool.
 *
 * Names, descriptions, icons and capability texts come from `labels`, so an app can translate or
 * rebrand them. Use `ensureBuiltinConnections` to create the connections.
 *
 * @example
 * ```ts
 * const definitions = builtinConnectors({
 *   files: { plugin: ({ tools }) => filesystem({ fs, tools: tools as FileToolName[] }) },
 *   planning: { plugin: () => todos() },
 *   labels: { files: { name: 'Files' } },
 * })
 * ```
 */
export function builtinConnectors(options: BuiltinConnectorsOptions = {}): ConnectorDefinition[] {
  const out: ConnectorDefinition[] = []
  const L = options.labels ?? {}
  const base = (
    id: BuiltinId,
    name: string,
    description: string,
    category: string,
    icon: string,
  ) => ({
    id,
    version: '1',
    name: L[id]?.name ?? name,
    description: L[id]?.description ?? description,
    icon: L[id]?.icon ?? icon,
    category: L[id]?.category ?? category,
    source: 'builtin' as const,
    auth: { type: 'none' as const },
    ...(L[id]?.instructions === undefined ? {} : { instructions: L[id]?.instructions }),
  })
  const scoped = (
    id: BuiltinId,
    defaults: Partial<
      Record<
        ConnectorScope,
        { label?: string; defaultEnabled?: boolean; defaultModes?: Record<string, CapabilityMode> }
      >
    >,
  ): { scopeDefaults: ConnectorDefinition['scopeDefaults'] } => {
    const merged: NonNullable<ConnectorDefinition['scopeDefaults']> = {}
    for (const [scope, value] of Object.entries(defaults) as Array<
      [ConnectorScope, NonNullable<(typeof defaults)[ConnectorScope]>]
    >) {
      const label = L[id]?.scopeLabels?.[scope] ?? value.label
      merged[scope] = { ...value, ...(label === undefined ? {} : { label }) }
    }
    return { scopeDefaults: merged }
  }

  if (options.files !== undefined) {
    const factory = options.files.plugin
    out.push(
      defineConnector({
        ...base('files', 'Files', 'Read and change files in the workspace.', 'workspace', 'folder'),
        scopes: ['workspace'],
        instances: 'single',
        capabilities: [
          cap(
            'read',
            'Read files',
            'Read, list and search files.',
            'read',
            BUILTIN_TOOLS.filesRead,
            L.files?.capabilities?.read,
          ),
          cap(
            'edit',
            'Edit files',
            'Create and change files.',
            'write',
            BUILTIN_TOOLS.filesEdit,
            L.files?.capabilities?.edit,
          ),
          cap(
            'delete',
            'Delete files',
            'Delete files.',
            'destructive',
            BUILTIN_TOOLS.filesDelete,
            L.files?.capabilities?.delete,
          ),
        ],
        ...scoped('files', { workspace: { defaultEnabled: true } }),
        activate: (ctx) => factory(inputOf(ctx), ctx),
      }),
    )
  }

  if (options.memory !== undefined) {
    const memory = options.memory
    out.push(
      defineConnector({
        ...base('memory', 'Memory', 'Remember notes across conversations.', 'workspace', 'brain'),
        scopes: ['workspace', 'agent'],
        capabilities: [
          cap(
            'read',
            'Read memory',
            'Look up saved notes.',
            'read',
            BUILTIN_TOOLS.memoryRead,
            L.memory?.capabilities?.read,
          ),
          cap(
            'write',
            'Save to memory',
            'Create, edit and delete notes.',
            'write',
            BUILTIN_TOOLS.memoryWrite,
            L.memory?.capabilities?.write,
          ),
        ],
        ...scoped('memory', {
          workspace: { label: 'Workspace memory', defaultEnabled: true },
          agent: { label: "This agent's memory", defaultEnabled: true },
        }),
        combine: (ctxs) => {
          const roots: BuiltinMemoryRoot[] = []
          for (const ctx of ctxs) {
            if (ctx.modes.read === 'off' && ctx.modes.write === 'off') continue
            const scope = ctx.connection.scope
            roots.push({
              path: scope === 'agent' ? memory.paths.agent(ctx.agent.id) : memory.paths.workspace,
              write: ctx.modes.write !== 'off',
              label: ctx.connection.label,
              scope,
              connectionId: ctx.connection.id,
            })
          }
          if (roots.length === 0) return undefined
          const first = ctxs[0] as ConnectorActivationContext
          const input: BuiltinInput = {
            tools: [...new Set(ctxs.flatMap((c) => c.tools))],
            modes: Object.fromEntries(
              Object.keys(first.modes).map((id) => {
                const on = ctxs.map((c) => c.modes[id]).filter((m) => m !== 'off')
                return [id, on.length === 0 ? 'off' : on.includes('ask') ? 'ask' : 'allow']
              }),
            ) as Record<string, CapabilityMode>,
            capabilities: first.capabilities,
          }
          return memory.plugin(roots, input)
        },
      }),
    )
  }

  if (options.planning !== undefined) {
    const factory = options.planning.plugin
    out.push(
      defineConnector({
        ...base(
          'planning',
          'Planning',
          'Keep a todo list while working.',
          'workspace',
          'list-checks',
        ),
        scopes: ['workspace'],
        instances: 'single',
        capabilities: [
          cap(
            'plan',
            'Plan with todos',
            'Write and update a todo list.',
            'write',
            BUILTIN_TOOLS.planning,
            L.planning?.capabilities?.plan,
          ),
        ],
        ...scoped('planning', { workspace: { defaultEnabled: true } }),
        activate: (ctx) => factory(inputOf(ctx), ctx),
      }),
    )
  }

  if (options.web?.search !== undefined || options.web?.read !== undefined) {
    const { search, read } = options.web
    const capabilities: CapabilityDef[] = []
    if (search !== undefined) {
      capabilities.push(
        cap(
          'search',
          'Search the web',
          'Search the web for pages.',
          'external',
          BUILTIN_TOOLS.webSearch,
          L.web?.capabilities?.search,
        ),
      )
    }
    if (read !== undefined) {
      capabilities.push(
        cap(
          'read',
          'Read web pages',
          'Fetch and read web pages.',
          'external',
          BUILTIN_TOOLS.webRead,
          L.web?.capabilities?.read,
        ),
      )
    }
    out.push(
      defineConnector({
        ...base('web', 'Web', 'Search the web and read pages.', 'workspace', 'globe'),
        scopes: ['workspace'],
        instances: 'single',
        capabilities,
        ...scoped('web', { workspace: { defaultEnabled: true } }),
        activate: async (ctx) => {
          const plugins: ConnectorActivation[] = []
          if (
            search !== undefined &&
            ctx.modes.search !== undefined &&
            ctx.modes.search !== 'off'
          ) {
            plugins.push(await search(inputOf(ctx), ctx))
          }
          if (read !== undefined && ctx.modes.read !== undefined && ctx.modes.read !== 'off') {
            plugins.push(await read(inputOf(ctx), ctx))
          }
          return plugins.flatMap((p) => (p === undefined ? [] : Array.isArray(p) ? p : [p]))
        },
      }),
    )
  }

  if (options.ask !== undefined) {
    const factory = options.ask.plugin
    out.push(
      defineConnector({
        ...base(
          'ask',
          'Ask the user',
          'Ask the user a question when something is unclear.',
          'workspace',
          'message-circle-question',
        ),
        scopes: ['workspace'],
        instances: 'single',
        capabilities: [
          cap(
            'ask',
            'Ask questions',
            'Ask the user a question and wait.',
            'read',
            BUILTIN_TOOLS.ask,
            L.ask?.capabilities?.ask,
          ),
        ],
        ...scoped('ask', { workspace: { defaultEnabled: true } }),
        activate: (ctx) => factory(inputOf(ctx), ctx),
      }),
    )
  }

  if (options.team !== undefined) {
    const factory = options.team.plugin
    out.push(
      defineConnector({
        ...base('team', 'Team', 'Work with other agents.', 'workspace', 'users'),
        scopes: ['workspace'],
        instances: 'single',
        capabilities: [
          cap(
            'delegate',
            'Delegate work',
            'Start other agents on a task and read their results.',
            'write',
            BUILTIN_TOOLS.teamDelegate,
            L.team?.capabilities?.delegate,
          ),
          cap(
            'message',
            'Message agents',
            'Send messages to other agents.',
            'write',
            BUILTIN_TOOLS.teamMessage,
            L.team?.capabilities?.message,
          ),
        ],
        // an agent works alone unless the workspace (or the agent) turns the team on
        ...scoped('team', { workspace: { defaultEnabled: false } }),
        activate: (ctx) => factory(inputOf(ctx), ctx),
      }),
    )
  }
  return out
}

/** Options of {@link ensureBuiltinConnections}. */
export interface EnsureBuiltinOptions {
  store: ConnectionStore
  definitions: readonly ConnectorDefinition[]
  /** Also create the agent-scoped connections of this agent (memory). */
  agentId?: string
  now?: () => number
}

/** Id of a built-in workspace connection. */
export const builtinConnectionId = (definitionId: string, agentId?: string): string =>
  agentId === undefined ? `builtin:${definitionId}` : `builtin:${definitionId}:agent:${agentId}`

/**
 * Create the connections of the built-in connectors that do not exist yet: one workspace
 * connection per built-in (id `builtin:<connector>`) and, with `agentId`, one agent connection
 * (`builtin:<connector>:agent:<agent>`) for the connectors whose `scopeDefaults.agent` is set
 * (memory). Idempotent; existing connections (and the changes made to them) are left alone.
 * Returns the ones it created.
 */
export async function ensureBuiltinConnections(
  options: EnsureBuiltinOptions,
): Promise<ConnectionRecord[]> {
  const now = (options.now ?? Date.now)()
  const created: ConnectionRecord[] = []
  const make = async (
    definition: ConnectorDefinition,
    scope: ConnectorScope,
    id: string,
    scopeId?: string,
  ): Promise<void> => {
    if ((await options.store.get(id)) !== undefined) return
    const defaults = definition.scopeDefaults?.[scope]
    const record: ConnectionRecord = {
      id,
      kind: 'connection',
      definitionId: definition.id,
      label: defaults?.label ?? definition.name,
      settings: {},
      enabled: true,
      status: 'connected',
      scope,
      ...(scopeId === undefined ? {} : { scopeId }),
      defaultEnabled: defaults?.defaultEnabled ?? true,
      ...(defaults?.defaultModes === undefined
        ? {}
        : { defaultModes: { ...defaults.defaultModes } }),
      createdAt: now,
      updatedAt: now,
    }
    await options.store.put(record)
    created.push(record)
  }
  for (const definition of options.definitions) {
    if (definition.source !== 'builtin') continue
    if (definition.scopes.includes('workspace')) {
      await make(definition, 'workspace', builtinConnectionId(definition.id))
    }
    if (
      options.agentId !== undefined &&
      definition.scopes.includes('agent') &&
      definition.scopeDefaults?.agent !== undefined
    ) {
      await make(
        definition,
        'agent',
        builtinConnectionId(definition.id, options.agentId),
        options.agentId,
      )
    }
  }
  return created
}
