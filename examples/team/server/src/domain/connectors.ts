/**
 * Connectors as the app sees them (structural DTOs of `eharness/connectors`, so domain / app / http
 * never import the library) and the mapping from the legacy tool checklist to connector
 * enablement. Pure: no I/O.
 *
 * A connection is workspace-scoped (connected once, inherited by agents with `defaultEnabled`) or
 * agent-scoped. Each agent keeps an enablement entry per connection: on / off / inherit, a mode
 * per capability (`allow`, `ask`, `off`) and, under "Advanced", a mode per tool.
 */
import { invalid } from './errors.ts'

export const CAPABILITY_MODES = ['allow', 'ask', 'off'] as const
export type CapabilityMode = (typeof CAPABILITY_MODES)[number]
export const ENABLED_STATES = ['inherit', 'on', 'off'] as const
export type EnabledState = (typeof ENABLED_STATES)[number]

/** One agent's choices for one connection (`ConnectionEnablement` of `eharness/connectors`). */
export interface ConnectionChoices {
  enabled?: EnabledState
  capabilities?: Record<string, CapabilityMode>
  tools?: Record<string, CapabilityMode>
  choices?: Record<string, unknown>
}

/** An agent's enablement: connection id -> choices (stored as JSON on the agent row). */
export type AgentConnectors = Record<string, ConnectionChoices>

export const BUILTIN_MEMORY_WORKSPACE = 'builtin:memory'
export const builtinId = (connector: string): string => `builtin:${connector}`
export const agentMemoryConnection = (agentId: string): string => `builtin:memory:agent:${agentId}`

const CONNECTION_ID = /^[A-Za-z0-9:_.-]{1,160}$/
const KEY = /^[A-Za-z0-9_.:*-]{1,128}$/

/** Validate what a client sent (shape and modes only; the connections are checked by the service). */
export function normalizeConnectors(input: unknown): AgentConnectors {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalid('connectors must be an object of connection id to choices')
  }
  const out: AgentConnectors = {}
  const modes = (value: unknown, what: string): Record<string, CapabilityMode> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw invalid(`${what} must be an object`)
    }
    const result: Record<string, CapabilityMode> = {}
    for (const [k, v] of Object.entries(value)) {
      if (!KEY.test(k)) throw invalid(`invalid ${what} key: ${k}`)
      if (!(CAPABILITY_MODES as readonly unknown[]).includes(v)) {
        throw invalid(`${what}.${k} must be allow, ask or off`)
      }
      result[k] = v as CapabilityMode
    }
    return result
  }
  for (const [id, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!CONNECTION_ID.test(id)) throw invalid(`invalid connection id: ${id}`)
    const v = (raw ?? {}) as Record<string, unknown>
    const entry: ConnectionChoices = {}
    if (v.enabled !== undefined) {
      if (!(ENABLED_STATES as readonly unknown[]).includes(v.enabled)) {
        throw invalid(`${id}: enabled must be inherit, on or off`)
      }
      entry.enabled = v.enabled as EnabledState
    }
    if (v.capabilities !== undefined) entry.capabilities = modes(v.capabilities, 'capabilities')
    if (v.tools !== undefined) entry.tools = modes(v.tools, 'tools')
    if (v.choices !== undefined && typeof v.choices === 'object' && v.choices !== null) {
      entry.choices = v.choices as Record<string, unknown>
    }
    out[id] = entry
  }
  return out
}

/** The legacy tool checklist names (kept only for the migration of old agent rows). */
export const LEGACY_TOOLS = [
  'library_read',
  'library_write',
  'memory',
  'todos',
  'web_search',
  'web_fetch',
  'ask_user',
  'delegate',
  'send_message',
  'mcp',
] as const

/** What a new agent gets when nothing else is said: the old default checklist. */
export const DEFAULT_LEGACY_TOOLS: readonly string[] = ['library_read', 'memory', 'todos']

/**
 * The enablement that reproduces a legacy tool checklist exactly (same tools, same rules):
 *
 * - `library_read` / `library_write` -> Files: read / edit and delete;
 * - `memory` -> workspace memory (writable for the lead only) and the agent's own memory;
 * - `todos` -> Planning; `web_search` / `web_fetch` -> Web; `ask_user` -> Ask the user;
 * - `delegate` -> Team (lead); `send_message` is part of Team and only counted with `delegate`
 *   (alone it never installed anything); a lead with `delegate` but not `send_message` keeps
 *   `agent_output` and `agent_stop` off, as before.
 *
 * Unused built-ins are switched off explicitly so a later change of the workspace defaults never
 * widens an existing agent.
 */
export function enablementFromTools(
  tools: readonly string[],
  agent: { id: string; role: string },
): AgentConnectors {
  const has = (t: string): boolean => tools.includes(t)
  const mode = (on: boolean): CapabilityMode => (on ? 'allow' : 'off')
  const lead = agent.role === 'lead'
  const out: AgentConnectors = {}
  const files = has('library_read') || has('library_write')
  out[builtinId('files')] = files
    ? {
        enabled: 'on',
        capabilities: {
          read: mode(has('library_read')),
          edit: mode(has('library_write')),
          delete: mode(has('library_write')),
        },
      }
    : { enabled: 'off' }
  const memory = has('memory')
  out[BUILTIN_MEMORY_WORKSPACE] = memory
    ? { enabled: 'on', capabilities: { read: 'allow', write: mode(lead) } }
    : { enabled: 'off' }
  out[agentMemoryConnection(agent.id)] = memory
    ? { enabled: 'on', capabilities: { read: 'allow', write: 'allow' } }
    : { enabled: 'off' }
  out[builtinId('planning')] = { enabled: has('todos') ? 'on' : 'off' }
  out[builtinId('web')] =
    has('web_search') || has('web_fetch')
      ? {
          enabled: 'on',
          capabilities: { search: mode(has('web_search')), read: mode(has('web_fetch')) },
        }
      : { enabled: 'off' }
  out[builtinId('ask')] = { enabled: has('ask_user') ? 'on' : 'off' }
  const delegates = lead && has('delegate')
  out[builtinId('team')] = delegates
    ? {
        enabled: 'on',
        capabilities: { delegate: 'allow', message: mode(has('send_message')) },
        ...(has('send_message') ? {} : { tools: { agent_output: 'off', agent_stop: 'off' } }),
      }
    : { enabled: 'off' }
  return out
}

// --- views ---------------------------------------------------------------------------------

export type ConnectorScopeView = 'workspace' | 'agent'

export interface CapabilityView {
  id: string
  title: string
  description: string
  kind: 'read' | 'write' | 'destructive' | 'external'
  tools: string[]
  defaultMode: CapabilityMode
}

/** A tool as "Advanced" shows it. */
export interface ToolModeView {
  name: string
  mode: CapabilityMode
  /** Set when this agent overrides the inherited mode. */
  override?: CapabilityMode
}

export interface AgentCapabilityView extends CapabilityView {
  /** Effective mode for this agent. */
  mode: CapabilityMode
  /** The mode without the agent's own choice (connection default, else the capability's). */
  inherited: CapabilityMode
  override?: CapabilityMode
  /** True when the tools of this capability always ask, even in Bypass mode. */
  pinned: boolean
  toolModes: ToolModeView[]
}

/** One connection as one agent sees it (`GET /agents/{id}/connectors`). */
export interface AgentConnectorView {
  connectionId: string
  connectorId: string
  /** Name of the connector ("GitHub"). */
  name: string
  icon?: string
  category: string
  source: 'builtin' | 'curated' | 'custom'
  /** Connection label ("Workspace memory", "work account"). */
  label: string
  accountLabel?: string
  status: 'connected' | 'needs-auth' | 'error' | 'disabled'
  statusMessage?: string
  scope: ConnectorScopeView
  /** `workspace`: connected once and shared; `agent`: only this agent has it. */
  ownership: 'workspace' | 'agent'
  /** Workspace connections: every agent gets it unless it opts out. */
  defaultEnabled: boolean
  /** This agent's own switch: inherit, on or off. */
  state: EnabledState
  /** Whether the agent uses the connection now. */
  enabled: boolean
  capabilities: AgentCapabilityView[]
}

// --- catalog, connections and flows (what the API shows) -----------------------------------

/** A settings field (`FormField` of `eharness/providers`, structural). */
export interface ConnectorFieldView {
  path: string
  kind: 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'record' | 'array' | 'json'
  widget?: 'password' | 'textarea' | 'keyvalue' | 'radio' | 'select'
  label: string
  description?: string
  required: boolean
  secret: boolean
  secretValues: boolean
  options?: Array<{ value: string | number | boolean; label: string }>
  default?: unknown
  group: 'auth' | 'endpoint' | 'advanced'
  showWhen?: { field: string; equals?: unknown; in?: unknown[] }
  placeholder?: string
  envHint?: string
  format?: string
  min?: number
  max?: number
}

/** How a connector's OAuth app credentials are provided (admin: environment or saved in the app). */
export interface OAuthClientView {
  /** The connector needs OAuth app credentials (no dynamic registration). */
  required: boolean
  configured: boolean
  source: 'env' | 'stored' | null
  /** The callback URL to register with the OAuth app. */
  redirectUri: string
  /** Environment variables that can provide the credentials. */
  envVars: string[]
}

export interface ConnectorView {
  id: string
  name: string
  description: string
  icon?: string
  category: string
  source: 'builtin' | 'curated' | 'custom'
  scopes: Array<'workspace' | 'agent' | 'user'>
  auth: { type: 'none' | 'apiKey' | 'oauth2' | 'deviceCode'; scopes?: string[] }
  /** The settings form. */
  fields: ConnectorFieldView[]
  /** What it can do (a connection that discovered tools may have its own list). */
  capabilities: CapabilityView[]
  /** Built-in connectors are included: there is no connect step. */
  builtin: boolean
  /** Only the lead agent can use it (Team). */
  leadOnly: boolean
  oauthClient?: OAuthClientView
}

export interface ConnectionView {
  id: string
  definitionId: string
  label: string
  enabled: boolean
  scope: 'workspace' | 'agent' | 'user'
  scopeId?: string
  status: 'connected' | 'needs-auth' | 'error' | 'disabled'
  statusMessage?: string
  accountLabel?: string
  defaultEnabled: boolean
  defaultModes?: Record<string, CapabilityMode>
  capabilities?: CapabilityView[]
  /** Settings with secrets as `{ set, hint? }`. */
  settings: Record<string, unknown>
  authorized: boolean
  builtin: boolean
  createdAt: number
  updatedAt: number
}

/** A setup flow as a browser sees it; `view` is one of the closed vocabulary (`type`). */
export interface FlowDto {
  id: string
  definitionId: string
  scope: 'workspace' | 'agent' | 'user'
  scopeId?: string
  label: string
  connectionId?: string
  status: 'active' | 'done' | 'failed' | 'cancelled'
  step: string
  rev: number
  view: { type: string; viewId: string; step: string; [key: string]: unknown }
  createdAt: number
  updatedAt: number
  expiresAt: number
}

export interface FlowResult {
  flow: FlowDto
  connection?: ConnectionView
}

export type FlowActResult =
  | ({ ok: true } & FlowResult)
  | ({
      ok: false
      error: 'stale-view' | 'expired' | 'finished' | 'invalid-action' | 'not-found'
      message: string
    } & Partial<FlowResult>)

export interface FlowStartInput {
  /** A new connection of this connector. */
  definitionId?: string
  /** Re-authorize this connection. */
  connectionId?: string
  scope?: 'workspace' | 'agent'
  /** The agent (`agent` scope). */
  scopeId?: string
  label?: string
  /** Workspace scope: every agent gets it (default false for curated, true for agent scope). */
  defaultEnabled?: boolean
}

export interface FlowActInput {
  viewId: string
  action: 'submit' | 'poll' | 'back' | 'cancel' | 'retry'
  data?: Record<string, unknown> | undefined
}

export interface ConnectionPatchInput {
  label?: string | undefined
  enabled?: boolean | undefined
  /** `keep-secret` semantics: a secret omitted, `""` or `{ keep: true }` keeps the stored value. */
  settings?: Record<string, unknown> | undefined
  scope?: 'workspace' | 'agent' | undefined
  /** With `scope: 'agent'`. */
  scopeId?: string | undefined
  defaultEnabled?: boolean | undefined
  defaultModes?: Record<string, CapabilityMode> | undefined
}

export interface ConnectionTestResult {
  ok: boolean
  message?: string
  accountLabel?: string
  /** How many tools the server exposes (when it was listed). */
  tools?: number
  connection: ConnectionView
}
