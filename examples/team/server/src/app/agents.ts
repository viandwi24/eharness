/** Agent use cases. */
import {
  AGENT_ROLES,
  type AgentDef,
  type AgentDraft,
  normalizeMcpServers,
  normalizeTools,
  PERMISSION_MODES,
  slugify,
  validateSlug,
} from '../domain/agents.ts'
import { conflict, invalid, notFound } from '../domain/errors.ts'
import { normalizeSelection } from '../domain/providers.ts'
import type { Deps } from './ports.ts'

const COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899']

export function listAgents(deps: Deps, opts: { includeArchived?: boolean } = {}): AgentDef[] {
  return deps.agents.list(opts)
}

/** Agents with their sidebar activity (last message, preview, unread). */
export function listAgentsWithActivity(deps: Deps, opts: { includeArchived?: boolean } = {}) {
  const activity = deps.tasks.activity()
  return deps.agents.list(opts).map((agent) => ({
    ...agent,
    lastActivity: activity.get(agent.id) ?? { lastMessageAt: null, preview: null, unread: 0 },
  }))
}

export function getAgent(deps: Deps, id: string): AgentDef {
  const def = deps.agents.get(id) ?? deps.agents.getBySlug(id)
  if (def === undefined) throw notFound('agent', id)
  return def
}

function uniqueSlug(deps: Deps, wanted: string): string {
  let slug = wanted
  for (let n = 2; deps.agents.getBySlug(slug) !== undefined; n++) {
    slug = `${wanted.slice(0, 36)}-${n}`
  }
  return slug
}

function checkDraft(draft: AgentDraft): void {
  if (draft.name.trim() === '') throw invalid('name must not be empty')
  if (draft.instructions.trim() === '') throw invalid('instructions must not be empty')
  if (draft.role !== undefined && !AGENT_ROLES.includes(draft.role)) {
    throw invalid(`unknown role: ${draft.role}`)
  }
  if (draft.permissionMode !== undefined && !PERMISSION_MODES.includes(draft.permissionMode)) {
    throw invalid(`unknown permission mode: ${draft.permissionMode}`)
  }
}

/**
 * The `{ profileId, modelId }` pick of a draft: a legacy `profile:model` string is split, an
 * explicit profile must exist, a plain id follows the default profile.
 */
function pick(
  deps: Deps,
  profile: string | null | undefined,
  model: string | null | undefined,
): { model: string | null; modelProfile: string | null } {
  const known = deps.providers.profileIds()
  const sel = normalizeSelection(profile, model, known)
  if (sel.profileId !== null && !known.includes(sel.profileId)) {
    throw invalid(`unknown provider profile: ${sel.profileId}`, 'UNKNOWN_PROFILE')
  }
  return { model: sel.modelId, modelProfile: sel.profileId }
}

export function createAgent(deps: Deps, draft: AgentDraft): AgentDef {
  checkDraft(draft)
  const role = draft.role ?? 'custom'
  if (role === 'lead' && deps.agents.list().some((a) => a.role === 'lead')) {
    throw conflict('the workspace already has a lead agent', 'LEAD_EXISTS')
  }
  let slug: string
  if (draft.slug === undefined) {
    slug = uniqueSlug(deps, slugify(draft.name))
  } else {
    validateSlug(draft.slug)
    if (deps.agents.getBySlug(draft.slug) !== undefined) {
      throw conflict(`slug already in use: ${draft.slug}`, 'SLUG_TAKEN')
    }
    slug = draft.slug
  }
  const now = deps.clock.now()
  const def: AgentDef = {
    id: deps.ids.next(),
    workspaceId: deps.workspaceId,
    slug,
    name: draft.name.trim(),
    role,
    avatar: draft.avatar ?? null,
    color: draft.color ?? (COLORS[deps.agents.count() % COLORS.length] as string),
    description: draft.description ?? '',
    instructions: draft.instructions,
    ...pick(deps, draft.modelProfile, draft.model),
    tools: normalizeTools(draft.tools ?? ['library_read', 'memory', 'todos'], role),
    skills: draft.skills ?? [],
    mcp: draft.mcp ?? [],
    mcpServers: normalizeMcpServers(draft.mcpServers ?? []),
    permissionMode: draft.permissionMode ?? 'default',
    rules: { allow: [], ask: [], deny: [], ...draft.rules },
    version: 1,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  }
  deps.agents.insert(def)
  return def
}

export type AgentPatch = Partial<Omit<AgentDraft, 'role' | 'slug'>>

/** Edit a definition: bumps `version`, so sessions pick it up on their next turn. */
export function updateAgent(deps: Deps, id: string, patch: AgentPatch): AgentDef {
  const current = getAgent(deps, id)
  if (current.archivedAt !== null) throw conflict('the agent is archived', 'ARCHIVED')
  const merged: AgentDraft = {
    name: patch.name ?? current.name,
    instructions: patch.instructions ?? current.instructions,
    permissionMode: patch.permissionMode ?? current.permissionMode,
  }
  checkDraft(merged)
  const next: AgentDef = {
    ...current,
    name: merged.name.trim(),
    instructions: merged.instructions,
    avatar: patch.avatar === undefined ? current.avatar : patch.avatar,
    color: patch.color ?? current.color,
    description: patch.description ?? current.description,
    ...(patch.model === undefined && patch.modelProfile === undefined
      ? { model: current.model, modelProfile: current.modelProfile }
      : pick(
          deps,
          patch.modelProfile === undefined ? current.modelProfile : patch.modelProfile,
          patch.model === undefined ? current.model : patch.model,
        )),
    tools: patch.tools === undefined ? current.tools : normalizeTools(patch.tools, current.role),
    skills: patch.skills ?? current.skills,
    mcp: patch.mcp ?? current.mcp,
    mcpServers:
      patch.mcpServers === undefined
        ? current.mcpServers
        : normalizeMcpServers(patch.mcpServers, current.mcpServers),
    permissionMode: patch.permissionMode ?? current.permissionMode,
    rules:
      patch.rules === undefined ? current.rules : { allow: [], ask: [], deny: [], ...patch.rules },
    version: current.version + 1,
    updatedAt: deps.clock.now(),
  }
  if (!deps.agents.update(next, current.version)) {
    throw conflict('the agent was changed concurrently; reload and retry', 'VERSION_CONFLICT')
  }
  return next
}

/** Delete = archive (sessions and history stay readable). */
export function archiveAgent(deps: Deps, id: string): AgentDef {
  const current = getAgent(deps, id)
  if (current.role === 'lead') throw conflict('the lead agent cannot be archived', 'LEAD_REQUIRED')
  if (current.archivedAt !== null) return current
  const next: AgentDef = {
    ...current,
    archivedAt: deps.clock.now(),
    updatedAt: deps.clock.now(),
    version: current.version + 1,
  }
  if (!deps.agents.update(next, current.version)) {
    throw conflict('the agent was changed concurrently; reload and retry', 'VERSION_CONFLICT')
  }
  return next
}
