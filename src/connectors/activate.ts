/**
 * `activateConnectors`: from connections and one agent's enablement to the plugins, tool
 * sources, permission rules and instructions that agent gets.
 *
 * @see docs/specs/24-connectors.md#7-activation
 */
import type { HarnessPlugin, ToolSource } from '../index.ts'
import { capabilitiesOf, connectorSchema } from './definition.ts'
import { isConnectionEnabled, mostRestrictive, resolveModes } from './enablement.ts'
import type {
  ActivatedConnectors,
  ActiveConnection,
  AgentEnablement,
  AnyConnectorDefinition,
  CapabilityKind,
  CapabilityMode,
  ConnectionRecord,
  ConnectorActivationContext,
  ConnectorContribution,
  ConnectorRules,
  ConnectorSource,
  ConnectorWarning,
  McpSourceSpec,
  ToolOrigin,
} from './types.ts'
import { connectorError, slugify } from './util.ts'

/** Default order of the built-in connectors in the prompt (stable for the prompt-cache prefix). */
export const DEFAULT_BUILTIN_ORDER: readonly string[] = [
  'files',
  'memory',
  'planning',
  'web',
  'ask',
  'team',
]

/** One tool as the rule compiler sees it. */
export interface CompiledTool {
  /** Final tool name (prefix applied). */
  name: string
  mode: CapabilityMode
  kind: CapabilityKind
  source: ConnectorSource
}

/** Options of {@link compileConnectorRules}. */
export interface CompileRulesOptions {
  /** Emit allow rules for built-in connectors too. Default `false` (the app's mode governs them). */
  allowBuiltin?: boolean
}

const unique = (list: string[]): string[] => [...new Set(list)]

/**
 * Compile tool modes to permission rules (tool-name rules for `eharness/permissions`):
 * - `off` becomes a deny rule;
 * - `ask` becomes an ask rule; when the tool belongs to a non-built-in connector and its
 *   capability is `write` or `destructive`, it is also **pinned**: listed in `pinnedAsk` and in
 *   `toolKinds` as `{ kind: 'other', alwaysAsk: true }`. Merge `toolKinds` into the engine's
 *   `toolKinds` and the tool asks in every mode, `bypassPermissions` included;
 * - `allow` becomes an allow rule (non-built-in connectors only, unless `allowBuiltin`).
 *
 * The permission engine already evaluates deny, then ask, then allow, so combining these rules
 * with the app's own gives the most restrictive outcome.
 */
export function compileConnectorRules(
  tools: readonly CompiledTool[],
  options: CompileRulesOptions = {},
): ConnectorRules {
  const rules: ConnectorRules = { allow: [], ask: [], deny: [], pinnedAsk: [], toolKinds: {} }
  for (const tool of tools) {
    if (tool.mode === 'off') rules.deny.push(tool.name)
    else if (tool.mode === 'ask') {
      rules.ask.push(tool.name)
      if (tool.source !== 'builtin' && (tool.kind === 'write' || tool.kind === 'destructive')) {
        rules.pinnedAsk.push(tool.name)
        rules.toolKinds[tool.name] = { kind: 'other', alwaysAsk: true }
      }
    } else if (tool.source !== 'builtin' || options.allowBuiltin === true) {
      rules.allow.push(tool.name)
    }
  }
  return {
    allow: unique(rules.allow),
    ask: unique(rules.ask),
    deny: unique(rules.deny),
    pinnedAsk: unique(rules.pinnedAsk),
    toolKinds: rules.toolKinds,
  }
}

/** Rule strings of the app's own permission rules. */
export interface AppRules {
  allow?: readonly string[]
  ask?: readonly string[]
  deny?: readonly string[]
}

/**
 * Combine connector rules with the app's: the result lists every rule, but an allow rule that
 * the other side asks or denies, and an ask rule the other side denies, is dropped, so the most
 * restrictive of the two wins even for a consumer that does not apply deny, ask, allow precedence
 * itself. Pinned asks are kept whatever the app allows.
 */
export function mergeConnectorRules(connector: ConnectorRules, app: AppRules = {}): ConnectorRules {
  const deny = unique([...connector.deny, ...(app.deny ?? [])])
  const denied = new Set(deny)
  const ask = unique([...connector.ask, ...(app.ask ?? [])]).filter((r) => !denied.has(r))
  const asked = new Set([...ask, ...connector.pinnedAsk])
  const allow = unique([...connector.allow, ...(app.allow ?? [])]).filter(
    (r) => !denied.has(r) && !asked.has(r),
  )
  return {
    allow,
    ask,
    deny,
    pinnedAsk: connector.pinnedAsk.filter((r) => !denied.has(r)),
    toolKinds: { ...connector.toolKinds },
  }
}

/** Options of {@link activateConnectors}. */
export interface ActivateOptions {
  definitions: readonly AnyConnectorDefinition[]
  connections: readonly ConnectionRecord[]
  /** This agent's enablement (connection id to choices). Default: none (everything inherits). */
  enablement?: AgentEnablement
  agent: { id: string }
  /** For `user`-scoped connections (reserved). */
  user?: { id: string }
  /** Order of the built-in connector ids; others follow by id. Default {@link DEFAULT_BUILTIN_ORDER}. */
  ordering?: { builtin?: readonly string[] }
  /** Access token of a connection (see `createCredentialManager`). Default: rejects as `needs-auth`. */
  accessToken?: (connectionId: string) => Promise<string>
  fetch?: typeof fetch
  /** Turns an {@link McpSourceSpec} into a tool source (`remoteMcpSource` from `eharness/mcp`). */
  mcp?: (spec: McpSourceSpec) => ToolSource
  /** The app's own rules, merged most-restrictive-wins into `rules`. */
  appRules?: AppRules
  /** Emit allow rules for built-in connectors too. Default `false`. */
  allowRulesForBuiltin?: boolean
}

interface Entry {
  record: ConnectionRecord
  definition: AnyConnectorDefinition
  ctx: ConnectorActivationContext
}

const isPlugin = (c: ConnectorContribution): c is HarnessPlugin => '~def' in c
const isSource = (c: ConnectorContribution): c is ToolSource => '~toolSource' in c

/**
 * Compute what one agent gets from the connections it uses.
 *
 * A connection is used when it is enabled, `connected`, valid for its definition and the agent's
 * enablement allows it (`inherit` follows `defaultEnabled` for workspace connections; an agent
 * connection belongs to its agent). The order of `plugins`, `mcpSources` and `instructions` is
 * stable and independent of the order of `connections`: the built-in connectors first in a fixed
 * order, then the others by connector id, within a connector by connection id (prompt-cache
 * prefix, spec 02 §5–6, ADR-0013). A connector with several connections is activated once per
 * connection with a tool prefix (`<slug>_`), or once for all of them through `combine`.
 *
 * Never throws for a bad connection: the problem is listed in `warnings` and the connection is
 * left out.
 *
 * @example
 * ```ts
 * const out = await activateConnectors({ definitions, connections, enablement, agent: { id: 'a1' }, accessToken: creds.getAccessToken, mcp: remoteMcpSource })
 * const agent = defineHarnessAgent({ plugins: out.plugins, tools: out.mcpSources, instructions: [base, ...out.instructions], ... })
 * ```
 */
export async function activateConnectors(options: ActivateOptions): Promise<ActivatedConnectors> {
  const result: ActivatedConnectors = {
    plugins: [],
    mcpSources: [],
    rules: { allow: [], ask: [], deny: [], pinnedAsk: [], toolKinds: {} },
    instructions: [],
    toolNameMap: {},
    connections: [],
    warnings: [],
  }
  const warn = (w: ConnectorWarning): void => {
    result.warnings.push(w)
  }
  const defs = new Map(options.definitions.map((d) => [d.id, d]))
  const enablement = options.enablement ?? {}
  const fetchFn = options.fetch ?? globalThis.fetch
  const order = options.ordering?.builtin ?? DEFAULT_BUILTIN_ORDER

  // 1. which connections apply
  const byConnector = new Map<
    string,
    Array<{ record: ConnectionRecord; definition: AnyConnectorDefinition }>
  >()
  for (const record of options.connections) {
    const definition = defs.get(record.definitionId)
    if (definition === undefined) {
      if (
        isConnectionEnabled(record, enablement[record.id], {
          agentId: options.agent.id,
          ...(options.user === undefined ? {} : { userId: options.user.id }),
        })
      ) {
        warn({
          code: 'unknown-definition',
          message: `Connection '${record.id}' uses unknown connector '${record.definitionId}'.`,
          connectionId: record.id,
          connectorId: record.definitionId,
        })
      }
      continue
    }
    if (!definition.scopes.includes(record.scope)) continue
    const subject = {
      agentId: options.agent.id,
      ...(options.user === undefined ? {} : { userId: options.user.id }),
    }
    if (!isConnectionEnabled(record, enablement[record.id], subject)) continue
    if (record.status !== 'connected') {
      warn({
        code: 'connection-unavailable',
        message: `Connection '${record.label}' is ${record.status}; skipped.`,
        connectionId: record.id,
        connectorId: definition.id,
      })
      continue
    }
    if (!connectorSchema(definition).safeParse(record.settings).success) {
      warn({
        code: 'invalid-settings',
        message: `Connection '${record.label}' has invalid settings; skipped.`,
        connectionId: record.id,
        connectorId: definition.id,
      })
      continue
    }
    const list = byConnector.get(definition.id) ?? []
    list.push({ record, definition })
    byConnector.set(definition.id, list)
  }

  // 2. stable connector order: built-ins in the fixed order, then the rest by id
  const rank = (id: string): number => {
    const index = order.indexOf(id)
    return index < 0 ? Number.MAX_SAFE_INTEGER : index
  }
  const connectorIds = [...byConnector.keys()].sort((a, b) => {
    const da = defs.get(a) as AnyConnectorDefinition
    const db = defs.get(b) as AnyConnectorDefinition
    const ba = da.source === 'builtin' ? 0 : 1
    const bb = db.source === 'builtin' ? 0 : 1
    if (ba !== bb) return ba - bb
    if (ba === 0 && rank(a) !== rank(b)) return rank(a) - rank(b)
    return a < b ? -1 : a > b ? 1 : 0
  })

  const compiled: CompiledTool[] = []
  const origins = new Map<
    string,
    { origin: ToolOrigin; modes: CapabilityMode[]; kind: CapabilityKind; source: ConnectorSource }
  >()

  for (const connectorId of connectorIds) {
    const definition = defs.get(connectorId) as AnyConnectorDefinition
    let list = (byConnector.get(connectorId) ?? []).sort((a, b) =>
      a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0,
    )
    const combine = definition.combine !== undefined
    if (list.length > 1 && !combine && definition.instances === 'single') {
      for (const extra of list.slice(1)) {
        warn({
          code: 'duplicate-instance',
          message: `Connector '${connectorId}' allows one connection per agent; '${extra.record.label}' was left out.`,
          connectionId: extra.record.id,
          connectorId,
        })
      }
      list = list.slice(0, 1)
    }
    const policy = definition.toolPrefix ?? 'multiple'
    const prefixed =
      policy === 'always' ? !combine : policy === 'never' ? false : list.length > 1 && !combine
    const taken = new Set<string>()
    const entries: Entry[] = list.map(({ record }) => {
      let slug = slugify(record.label) || slugify(record.id) || 'connection'
      if (taken.has(slug)) slug = `${slug.slice(0, 28)}-${taken.size + 1}`
      taken.add(slug)
      const modes = resolveModes(capabilitiesOf(definition, record), record, enablement[record.id])
      const ctx: ConnectorActivationContext = {
        connector: { id: definition.id, version: definition.version },
        connection: {
          id: record.id,
          label: record.label,
          scope: record.scope,
          ...(record.scopeId === undefined ? {} : { scopeId: record.scopeId }),
          ...(record.accountLabel === undefined ? {} : { accountLabel: record.accountLabel }),
          getAccessToken:
            options.accessToken === undefined
              ? () =>
                  Promise.reject(
                    connectorError('needs-auth', 'No access token provider is configured.', {
                      connectionId: record.id,
                    }),
                  )
              : () => (options.accessToken as (id: string) => Promise<string>)(record.id),
        },
        settings: connectorSchema(definition).parse(record.settings),
        choices: { ...record.choices, ...enablement[record.id]?.choices },
        agent: { id: options.agent.id },
        modes: modes.modes,
        capabilities: modes.capabilities,
        tools: modes.tools,
        toolModes: modes.toolModes,
        toolPrefix: prefixed ? `${slug}_` : '',
        slug,
        fetch: fetchFn,
      }
      return { record, definition, ctx }
    })

    // rules and the tool map (from every used connection, even when activation is skipped)
    for (const entry of entries) {
      for (const cap of capabilitiesOf(definition, entry.record)) {
        for (const tool of cap.tools) {
          const name = `${entry.ctx.toolPrefix}${tool}`
          const mode = entry.ctx.toolModes[tool] ?? cap.defaultMode
          const known = origins.get(name)
          if (known === undefined) {
            origins.set(name, {
              origin: { connectorId, connectionIds: [entry.record.id], capabilityId: cap.id, tool },
              modes: [mode],
              kind: cap.kind,
              source: definition.source,
            })
          } else {
            known.origin.connectionIds.push(entry.record.id)
            known.modes.push(mode)
          }
        }
      }
    }

    // activation (skipped when every capability is off)
    const anyOn = entries.some(
      (e) =>
        e.ctx.capabilities.length > 0 ||
        e.ctx.tools.length > 0 ||
        capabilitiesOf(definition, e.record).length === 0,
    )
    const activeEntries = entries.filter(
      (e) =>
        e.ctx.capabilities.length > 0 ||
        e.ctx.tools.length > 0 ||
        capabilitiesOf(definition, e.record).length === 0,
    )
    if (anyOn) {
      let contributions: Array<{ item: ConnectorContribution; owner?: Entry }> = []
      try {
        if (combine && activeEntries.length > 0) {
          contributions = toList(await definition.combine?.(activeEntries.map((e) => e.ctx))).map(
            (item) => ({ item }),
          )
        } else {
          for (const entry of activeEntries) {
            for (const item of toList(await definition.activate?.(entry.ctx))) {
              contributions.push({ item, owner: entry })
            }
          }
        }
      } catch (error) {
        warn({
          code: 'activate-failed',
          message: `Connector '${connectorId}' failed to activate: ${error instanceof Error ? error.message : String(error)}`,
          connectorId,
        })
        contributions = []
      }
      for (const { item: contribution, owner } of contributions) {
        if (isPlugin(contribution)) result.plugins.push(contribution)
        else if (isSource(contribution)) result.mcpSources.push(contribution)
        else if (contribution.kind === 'mcp') {
          if (options.mcp === undefined) {
            warn({
              code: 'mcp-factory-missing',
              message: `Connector '${connectorId}' contributes an MCP server but no \`mcp\` factory was given.`,
              connectorId,
            })
          } else {
            const ctx = owner?.ctx
            const declared =
              ctx === undefined
                ? []
                : capabilitiesOf(definition, owner?.record).flatMap((c) => c.tools)
            const offTools =
              ctx === undefined ? [] : declared.filter((t) => ctx.toolModes[t] === 'off')
            const spec: McpSourceSpec = {
              ...contribution,
              prefix: contribution.prefix ?? ctx?.toolPrefix ?? '',
              ...(contribution.allow === undefined && declared.length > 0 && ctx !== undefined
                ? { allow: declared.filter((t) => ctx.toolModes[t] !== 'off') }
                : {}),
              ...(offTools.length === 0 && contribution.deny === undefined
                ? {}
                : { deny: unique([...(contribution.deny ?? []), ...offTools]) }),
            }
            result.mcpSources.push(options.mcp(spec))
          }
        }
      }
      if (definition.instructions !== undefined && definition.instructions !== '') {
        result.instructions.push(definition.instructions)
      }
    }
    for (const entry of entries) {
      result.connections.push({
        connectionId: entry.record.id,
        connectorId,
        slug: entry.ctx.slug,
        toolPrefix: entry.ctx.toolPrefix,
        modes: { ...entry.ctx.modes },
      } satisfies ActiveConnection)
    }
  }

  // rules: one mode per final tool name (shared tools: the most restrictive of the connections that keep them on)
  for (const [name, entry] of origins) {
    const on = entry.modes.filter((m) => m !== 'off')
    const mode: CapabilityMode = on.length === 0 ? 'off' : mostRestrictive(...on)
    compiled.push({ name, mode, kind: entry.kind, source: entry.source })
    result.toolNameMap[name] = entry.origin
  }
  const rules = compileConnectorRules(compiled, {
    ...(options.allowRulesForBuiltin === undefined
      ? {}
      : { allowBuiltin: options.allowRulesForBuiltin }),
  })
  result.rules =
    options.appRules === undefined ? rules : mergeConnectorRules(rules, options.appRules)
  return result
}

function toList(value: unknown): ConnectorContribution[] {
  if (value === undefined || value === null) return []
  return (Array.isArray(value) ? value : [value]) as ConnectorContribution[]
}
