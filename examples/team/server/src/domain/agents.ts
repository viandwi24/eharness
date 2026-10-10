/** Agent definitions (the blueprint, plan §4) and the tool catalog. Pure: no I/O. */
import { invalid } from './errors.ts'

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

/**
 * A remote MCP server of an agent. Only `http` (streamable HTTP) and `sse` exist here: a stdio
 * transport spawns a process on the server host, which a multi-user, multi-instance server must
 * not do on behalf of a definition anyone can edit (and a restarted or second instance would not
 * have the process anyway).
 */
export interface McpServerDef {
  /** Tool prefix and source id (`mcp:<name>`): `^[a-z0-9-]{1,32}$`, unique per agent. */
  name: string
  transport: {
    type: 'http' | 'sse'
    url: string
    /** Stored server-side only (typically `Authorization`); never returned by the API. */
    headers: Record<string, string>
  }
  /** Allow list of the server's tool names (before prefixing). */
  allow?: string[]
  /** Deny list of the server's tool names (before prefixing). */
  deny?: string[]
}

/** What a client sends: `headers` omitted keeps the stored headers of the same-named server. */
export interface McpServerInput {
  name: string
  transport: { type: 'http' | 'sse'; url: string; headers?: Record<string, string> | undefined }
  allow?: string[] | undefined
  deny?: string[] | undefined
}

/** What the API returns: the names of the headers that are set, never their values. */
export interface McpServerView {
  name: string
  transport: { type: 'http' | 'sse'; url: string; headerNames: string[] }
  allow?: string[]
  deny?: string[]
}

const MCP_NAME = /^[a-z0-9-]{1,32}$/
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/
export const MAX_MCP_SERVERS = 8

/**
 * Validate the servers a client sent and merge secrets: a server without `headers` keeps the
 * headers stored under the same name (so an edit never needs the secret again).
 */
export function normalizeMcpServers(
  input: readonly McpServerInput[],
  current: readonly McpServerDef[] = [],
): McpServerDef[] {
  if (input.length > MAX_MCP_SERVERS) throw invalid(`at most ${MAX_MCP_SERVERS} MCP servers`)
  const seen = new Set<string>()
  return input.map((s) => {
    if (!MCP_NAME.test(s.name)) throw invalid(`MCP server name must match ${MCP_NAME}: ${s.name}`)
    if (seen.has(s.name)) throw invalid(`duplicate MCP server name: ${s.name}`)
    seen.add(s.name)
    if (s.transport.type !== 'http' && s.transport.type !== 'sse') {
      throw invalid(`MCP transport must be http or sse (no stdio): ${s.name}`)
    }
    let url: URL
    try {
      url = new URL(s.transport.url)
    } catch {
      throw invalid(`MCP server ${s.name}: invalid url`)
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw invalid(`MCP server ${s.name}: url must be http or https`)
    }
    const headers =
      s.transport.headers ?? current.find((c) => c.name === s.name)?.transport.headers ?? {}
    for (const [k, v] of Object.entries(headers)) {
      if (!HEADER_NAME.test(k) || /[\r\n]/.test(v)) {
        throw invalid(`MCP server ${s.name}: invalid header ${k}`)
      }
    }
    return {
      name: s.name,
      transport: { type: s.transport.type, url: url.toString(), headers },
      ...(s.allow === undefined ? {} : { allow: s.allow }),
      ...(s.deny === undefined ? {} : { deny: s.deny }),
    }
  })
}

export function redactMcpServers(servers: readonly McpServerDef[]): McpServerView[] {
  return servers.map((s) => ({
    name: s.name,
    transport: {
      type: s.transport.type,
      url: s.transport.url,
      headerNames: Object.keys(s.transport.headers),
    },
    ...(s.allow === undefined ? {} : { allow: s.allow }),
    ...(s.deny === undefined ? {} : { deny: s.deny }),
  }))
}

/** An agent as the API shows it: MCP secrets redacted. */
export function redactAgent<T extends { mcpServers: McpServerDef[] }>(
  def: T,
): Omit<T, 'mcpServers'> & { mcpServers: McpServerView[] } {
  return { ...def, mcpServers: redactMcpServers(def.mcpServers) }
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
  tools: ToolName[]
  skills: string[]
  mcp: string[]
  /** Remote MCP servers of this agent (secrets inside: never return it from the API as is). */
  mcpServers: McpServerDef[]
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
  modelProfile?: string | null | undefined
  tools?: string[] | undefined
  skills?: string[] | undefined
  mcp?: string[] | undefined
  mcpServers?: McpServerInput[] | undefined
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
