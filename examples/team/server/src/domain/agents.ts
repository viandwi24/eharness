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
  /** How much the model thinks before it answers: `default` = the model's own setting. */
  thinking: AgentThinking
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
  /** Reasoning level (`default` = the model's own); default `default`. */
  thinking?: AgentThinking | undefined
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

/** An AI SDK `reasoning` level (the same values as eharness `ThinkingLevel`). */
export type ThinkingLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** What the model catalog knows of a model's reasoning (the shape of eharness `ModelThinking`). */
export interface ModelThinking {
  levels?: ThinkingLevel[]
  mandatory?: boolean
  defaultLevel?: ThinkingLevel
}

/** The thinking setting of an agent: the model's own (`default`), off (`none`) or a level. */
export type AgentThinking = 'default' | ThinkingLevel

/** Every value of {@link AgentThinking}, weakest level first. */
export const AGENT_THINKING: readonly [
  'default',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * The AI SDK `reasoning` value an agent's setting sends to its current model, or `undefined` for the
 * model's own. A level the model does not take (its catalog lists the levels) becomes the nearest one
 * it does, the stronger one on a tie; `none` for a model that always thinks sends nothing.
 */
export function thinkingFor(
  setting: AgentThinking,
  model: ModelThinking | undefined,
): ThinkingLevel | undefined {
  if (setting === 'default') return undefined
  const levels = model?.levels
  if (levels === undefined || levels.length === 0) {
    return setting === 'none' && model?.mandatory === true ? undefined : setting
  }
  if (levels.includes(setting)) return setting
  if (setting === 'none') return undefined
  const rank = (l: AgentThinking): number => AGENT_THINKING.indexOf(l)
  const candidates = levels.filter((l) => l !== 'none')
  if (candidates.length === 0) return undefined
  let best = candidates[0] as ThinkingLevel
  for (const l of candidates) {
    const d = Math.abs(rank(l) - rank(setting))
    const bd = Math.abs(rank(best) - rank(setting))
    if (d < bd || (d === bd && rank(l) > rank(best))) best = l
  }
  return best
}
