/** Agent definitions (the blueprint, plan §4) and the tool catalog. Pure: no I/O. */
import type { AgentConnectors } from './connectors.ts'
import { invalid } from './errors.ts'

/**
 * How the tools of third-party connectors reach the model (Claude's "Tool access"): `auto` loads
 * them up front until an agent has {@link TOOL_ACCESS_AUTO_THRESHOLD} or more (then they are found
 * with `tool_search`); `on-demand` always defers them. Built-in connectors are never deferred.
 */
export const TOOL_ACCESS = ['auto', 'on-demand'] as const
export type ToolAccess = (typeof TOOL_ACCESS)[number]
/** Third-party tools an agent may have loaded up front in `auto` mode (the MCP auto-defer threshold). */
export const TOOL_ACCESS_AUTO_THRESHOLD = 20

export const AGENT_ROLES = ['lead', 'role', 'custom'] as const
export type AgentRole = (typeof AGENT_ROLES)[number]

/**
 * Stored values of an agent's `permissionMode`. The product offers three (`domain/modes.ts`):
 * `manual`, `auto` and `bypassPermissions`, plus `default` = "inherit the workspace default"
 * (the legacy meaning, kept for stored rows). `acceptEdits`, `plan` and `dontAsk` are legacy
 * values: they still parse and display as Manual.
 */
export const PERMISSION_MODES = [
  'default',
  'manual',
  'auto',
  'bypassPermissions',
  'acceptEdits',
  'plan',
  'dontAsk',
] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]

export interface PermissionRules {
  allow: string[]
  ask: string[]
  deny: string[]
}

export interface AgentDef {
  id: string
  workspaceId: string
  slug: string
  name: string
  role: AgentRole
  avatar: string | null
  color: string
  description: string
  instructions: string
  /** Model id (provider-specific); null = the workspace default model. */
  model: string | null
  /** Provider profile the model comes from; null = the default profile (`{ profileId, modelId }`). */
  modelProfile: string | null
  /** Connector enablement: which connections the agent uses and how freely (domain/connectors.ts). */
  connectors: AgentConnectors
  /** Tool access of third-party connectors; null = the workspace default. */
  toolAccess: ToolAccess | null
  /** Assigned tasks (the work queue) this agent works on at the same time; the rest wait as Queued. */
  taskConcurrency: number
  /** Own context limit in tokens; null = the full window of the current model. Never above the model's window. */
  contextWindow: number | null
  /** History is summarized at this share (percent, 50-95) of the effective window. */
  compactAtPercent: number
  skills: string[]
  permissionMode: PermissionMode
  rules: PermissionRules
  /** Bumps on every edit; the factory cache key is `id@version`. */
  version: number
  archivedAt: number | null
  createdAt: number
  updatedAt: number
}

/** Fields a user can set. */
export interface AgentDraft {
  /** A given id (a restore keeps ids); used only when no agent has it. */
  id?: string | undefined
  slug?: string | undefined
  name: string
  role?: AgentRole | undefined
  avatar?: string | null | undefined
  color?: string | undefined
  description?: string | undefined
  instructions: string
  model?: string | null | undefined
  modelProfile?: string | null | undefined
  /** Null/absent = the workspace default. */
  toolAccess?: ToolAccess | null | undefined
  /** Assigned tasks worked on at once (1-8, default 1). */
  taskConcurrency?: number | undefined
  /** Own context limit in tokens (at most the model's window); null/absent = the model's window. */
  contextWindow?: number | null | undefined
  /** Summarize at this percent (50-95) of the window; default 80. */
  compactAtPercent?: number | undefined
  /** Default: the legacy default checklist as enablement (files read, memory, planning). */
  connectors?: AgentConnectors | undefined
  /** Seeds and tests: a legacy tool checklist (`library_read`, `memory`, ...) mapped onto connectors. */
  toolset?: readonly string[] | undefined
  skills?: string[] | undefined
  permissionMode?: PermissionMode | undefined
  rules?: Partial<PermissionRules> | undefined
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return slug === '' ? 'agent' : slug
}

export function validateSlug(slug: string): void {
  if (!SLUG.test(slug)) {
    throw invalid(`slug must match ${SLUG} (lowercase letters, digits, dashes): ${slug}`)
  }
}

export function isLead(def: Pick<AgentDef, 'role'>): boolean {
  return def.role === 'lead'
}

/** The roster line the lead's reminder and the delegate tool use. */
export function rosterLine(def: Pick<AgentDef, 'slug' | 'name' | 'description'>): string {
  return `${def.slug}: ${def.name}${def.description === '' ? '' : ` - ${def.description}`}`
}
