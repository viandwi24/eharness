/** Agent definitions (the blueprint, plan §4) and the tool catalog. Pure: no I/O. */
import { invalid } from './errors.ts'

export const AGENT_ROLES = ['lead', 'role', 'custom'] as const
export type AgentRole = (typeof AGENT_ROLES)[number]

export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'dontAsk',
  'bypassPermissions',
] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]

export interface PermissionRules {
  allow: string[]
  ask: string[]
  deny: string[]
}

/**
 * The fixed tool catalog. A definition picks names from it; it cannot invent a tool (plan §6.1).
 * The order here is the order the factory installs them in (prompt-cache prefix).
 */
export const TOOL_CATALOG = [
  { name: 'library_read', description: 'List, read, grep and glob files of the shared library.' },
  { name: 'library_write', description: 'Write, edit and delete files of the shared library.' },
  { name: 'memory', description: 'Read and write workspace and per-agent memory files.' },
  { name: 'todos', description: 'Plan and track multi-step work with a todo list.' },
  { name: 'web_search', description: 'Search the web.' },
  { name: 'web_fetch', description: 'Fetch and read a web page.' },
  { name: 'ask_user', description: 'Ask the user a question and wait for the answer.' },
  { name: 'delegate', description: 'Delegate work to role agents (lead only).' },
  { name: 'send_message', description: 'Message another agent (lead only).' },
  { name: 'mcp', description: 'Tools of the MCP servers configured for the agent.' },
] as const

export type ToolName = (typeof TOOL_CATALOG)[number]['name']
export const TOOL_NAMES: readonly ToolName[] = TOOL_CATALOG.map((t) => t.name)

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
  /** Model id (provider-specific); null = the workspace default. */
  model: string | null
  tools: ToolName[]
  skills: string[]
  mcp: string[]
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
  slug?: string | undefined
  name: string
  role?: AgentRole | undefined
  avatar?: string | null | undefined
  color?: string | undefined
  description?: string | undefined
  instructions: string
  model?: string | null | undefined
  tools?: string[] | undefined
  skills?: string[] | undefined
  mcp?: string[] | undefined
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

/** Catalog check: unknown tool names are rejected, duplicates dropped, catalog order kept. */
export function normalizeTools(tools: readonly string[], role: AgentRole): ToolName[] {
  const unknown = tools.filter((t) => !(TOOL_NAMES as readonly string[]).includes(t))
  if (unknown.length > 0) {
    throw invalid(`unknown tools: ${unknown.join(', ')} (catalog: ${TOOL_NAMES.join(', ')})`)
  }
  const wanted = new Set(tools)
  if (role !== 'lead' && (wanted.has('delegate') || wanted.has('send_message'))) {
    throw invalid('delegate and send_message are only available to the lead agent')
  }
  return TOOL_NAMES.filter((t) => wanted.has(t))
}

export function isLead(def: Pick<AgentDef, 'role'>): boolean {
  return def.role === 'lead'
}

/** The roster line the lead's reminder and the delegate tool use. */
export function rosterLine(def: Pick<AgentDef, 'slug' | 'name' | 'description'>): string {
  return `${def.slug}: ${def.name}${def.description === '' ? '' : ` - ${def.description}`}`
}
