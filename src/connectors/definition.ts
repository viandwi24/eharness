/**
 * `defineConnector` and what is derived from a definition: the merged settings schema, the form,
 * the public description and the public connection.
 *
 * @see docs/specs/24-connectors.md#1-connector-definition
 */
import { z } from 'zod/v4'
import { formSpec, type ProviderFormSpec, redactProfile } from '../providers/index.ts'
import type {
  AnyConnectorDefinition,
  CapabilityDef,
  ConnectionRecord,
  ConnectorDefinition,
  ConnectorScope,
  ConnectorSource,
  PublicConnection,
} from './types.ts'
import { connectorError } from './util.ts'

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const SCOPES: readonly ConnectorScope[] = ['workspace', 'agent', 'user']
const SOURCES: readonly ConnectorSource[] = ['builtin', 'curated', 'custom']
const KINDS = ['read', 'write', 'destructive', 'external']
const MODES = ['allow', 'ask', 'off']

/**
 * Validate and return a connector definition (typed from its settings schema). Throws
 * `EH_CONFIG_INVALID` for a bad id, an empty scope list, duplicate capability ids, a tool that
 * belongs to two capabilities, or auth fields that collide with settings fields.
 *
 * @example
 * ```ts
 * export const github = defineConnector({
 *   id: 'github', version: '1', name: 'GitHub', description: '...', category: 'dev',
 *   source: 'curated', scopes: ['workspace', 'agent'],
 *   auth: { type: 'oauth2', scopes: ['repo'], pkce: true, authorizationUrl, tokenUrl },
 *   capabilities: [{ id: 'read', title: 'Read', description: '...', kind: 'read', tools: ['get_issue'], defaultMode: 'allow' }],
 *   activate: (ctx) => ({ kind: 'mcp', name: ctx.slug, url: 'https://mcp.example.com', getAccessToken: ctx.connection.getAccessToken }),
 * })
 * ```
 */
export function defineConnector<S extends z.ZodObject = z.ZodObject>(
  definition: ConnectorDefinition<S>,
): ConnectorDefinition<S> {
  const at = `defineConnector('${String(definition?.id)}')`
  if (typeof definition !== 'object' || definition === null) {
    throw connectorError('definition-invalid', 'defineConnector: a definition object is required.')
  }
  if (typeof definition.id !== 'string' || !ID.test(definition.id)) {
    throw connectorError('definition-invalid', `${at}: \`id\` must match ${ID}.`)
  }
  for (const key of ['version', 'name', 'description', 'category'] as const) {
    if (typeof definition[key] !== 'string' || definition[key] === '') {
      throw connectorError('definition-invalid', `${at}: \`${key}\` is required.`)
    }
  }
  if (!SOURCES.includes(definition.source)) {
    throw connectorError('definition-invalid', `${at}: invalid \`source\`.`)
  }
  if (
    !Array.isArray(definition.scopes) ||
    definition.scopes.length === 0 ||
    !definition.scopes.every((s) => SCOPES.includes(s))
  ) {
    throw connectorError(
      'definition-invalid',
      `${at}: \`scopes\` must list workspace, agent or user.`,
    )
  }
  if (typeof definition.auth !== 'object' || definition.auth === null) {
    throw connectorError('definition-invalid', `${at}: \`auth\` is required.`)
  }
  const capIds = new Set<string>()
  const toolOwner = new Map<string, string>()
  for (const cap of definition.capabilities ?? []) {
    if (typeof cap.id !== 'string' || cap.id === '' || capIds.has(cap.id)) {
      throw connectorError(
        'definition-invalid',
        `${at}: capability ids must be unique and not empty.`,
      )
    }
    capIds.add(cap.id)
    if (!KINDS.includes(cap.kind) || !MODES.includes(cap.defaultMode)) {
      throw connectorError(
        'definition-invalid',
        `${at}: capability '${cap.id}' has an invalid kind or mode.`,
      )
    }
    for (const tool of cap.tools) {
      const owner = toolOwner.get(tool)
      if (tool === '*' || tool === '') {
        throw connectorError(
          'definition-invalid',
          `${at}: capability '${cap.id}' lists an invalid tool name.`,
        )
      }
      if (owner !== undefined && owner !== cap.id) {
        throw connectorError(
          'definition-invalid',
          `${at}: tool '${tool}' belongs to capabilities '${owner}' and '${cap.id}'.`,
        )
      }
      toolOwner.set(tool, cap.id)
    }
  }
  connectorSchema(definition) // throws on a collision
  return definition
}

const schemas = new WeakMap<object, z.ZodObject>()

/**
 * The settings schema of a connector as the connection stores it: the `apiKey` auth fields and
 * the `settings` fields in one object (a name used by both is an error).
 */
export function connectorSchema(definition: AnyConnectorDefinition): z.ZodObject {
  const cached = schemas.get(definition)
  if (cached !== undefined) return cached
  const shape: Record<string, z.core.$ZodType> = {}
  const add = (schema: z.ZodObject | undefined, what: string): void => {
    if (schema === undefined) return
    for (const [key, value] of Object.entries(schema.shape)) {
      if (Object.hasOwn(shape, key)) {
        throw connectorError(
          'definition-invalid',
          `defineConnector('${definition.id}'): the ${what} field '${key}' is also defined by the other schema.`,
        )
      }
      shape[key] = value as z.core.$ZodType
    }
  }
  add(definition.auth.type === 'apiKey' ? definition.auth.fields : undefined, 'auth')
  add(definition.settings, 'settings')
  const merged = z.object(shape)
  schemas.set(definition, merged)
  return merged
}

/** The form of a connector's settings (auth fields first). */
export function connectorForm(definition: AnyConnectorDefinition): ProviderFormSpec {
  return formSpec(connectorSchema(definition))
}

/** Default label of a new connection: the scope default, else the connector name. */
export function defaultConnectionLabel(
  definition: AnyConnectorDefinition,
  scope: ConnectorScope,
): string {
  return definition.scopeDefaults?.[scope]?.label ?? definition.name
}

/** The capabilities in force for a connection: the ones discovered at connect time, else the definition's. */
export function capabilitiesOf(
  definition: AnyConnectorDefinition,
  connection?: Pick<ConnectionRecord, 'capabilities'>,
): CapabilityDef[] {
  return connection?.capabilities !== undefined && connection.capabilities.length > 0
    ? connection.capabilities
    : definition.capabilities
}

/** A connection with its secrets replaced by `{ set, hint? }`. */
export function publicConnection(
  definition: AnyConnectorDefinition,
  record: ConnectionRecord,
  options: { authorized?: boolean } = {},
): PublicConnection {
  return {
    ...redactProfile(connectorSchema(definition), record),
    authorized: options.authorized ?? false,
  }
}

/** What a UI shows of a connector (no functions, no secrets). */
export interface ConnectorDescription {
  id: string
  version: string
  name: string
  description: string
  icon?: string
  category: string
  source: ConnectorSource
  scopes: ConnectorScope[]
  auth: {
    type: 'none' | 'apiKey' | 'oauth2' | 'deviceCode'
    scopes?: string[]
    discovery?: 'mcp'
    dcr?: 'auto' | 'never'
  }
  form: ProviderFormSpec
  capabilities: CapabilityDef[]
  scopeDefaults?: ConnectorDefinition['scopeDefaults']
}

/** The public description of a definition. */
export function describeConnector(definition: AnyConnectorDefinition): ConnectorDescription {
  const auth = definition.auth
  const out: ConnectorDescription = {
    id: definition.id,
    version: definition.version,
    name: definition.name,
    description: definition.description,
    category: definition.category,
    source: definition.source,
    scopes: [...definition.scopes],
    auth: {
      type: auth.type,
      ...(auth.type === 'oauth2' || auth.type === 'deviceCode' ? { scopes: [...auth.scopes] } : {}),
      ...(auth.type === 'oauth2' && auth.discovery !== undefined
        ? { discovery: auth.discovery }
        : {}),
      ...(auth.type === 'oauth2' && auth.dcr !== undefined ? { dcr: auth.dcr } : {}),
    },
    form: connectorForm(definition),
    capabilities: structuredClone(definition.capabilities),
  }
  if (definition.icon !== undefined) out.icon = definition.icon
  if (definition.scopeDefaults !== undefined)
    out.scopeDefaults = structuredClone(definition.scopeDefaults)
  return out
}
