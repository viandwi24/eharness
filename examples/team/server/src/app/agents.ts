/** Agent use cases. */
import {
  AGENT_ROLES,
  type AgentDef,
  type AgentDraft,
  PERMISSION_MODES,
  slugify,
  TOOL_ACCESS,
  validateSlug,
} from '../domain/agents.ts'
import {
  builtinId,
  DEFAULT_LEGACY_TOOLS,
  enablementFromTools,
  normalizeConnectors,
} from '../domain/connectors.ts'
import {
  customWindowProblem,
  DEFAULT_COMPACT_AT_PERCENT,
  MAX_COMPACT_AT_PERCENT,
  MIN_COMPACT_AT_PERCENT,
} from '../domain/context-window.ts'
import { conflict, invalid, notFound } from '../domain/errors.ts'
import { normalizeSelection } from '../domain/providers.ts'
import { DEFAULT_TASK_CONCURRENCY, MAX_TASK_CONCURRENCY } from '../domain/work-queue.ts'
import { ensurePersona, personaFromInstructions } from './persona.ts'
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
  if (draft.toolAccess != null && !TOOL_ACCESS.includes(draft.toolAccess)) {
    throw invalid(`toolAccess must be one of ${TOOL_ACCESS.join(', ')}`)
  }
  if (
    draft.taskConcurrency !== undefined &&
    !(
      Number.isInteger(draft.taskConcurrency) &&
      draft.taskConcurrency >= 1 &&
      draft.taskConcurrency <= MAX_TASK_CONCURRENCY
    )
  ) {
    throw invalid(`taskConcurrency must be an integer from 1 to ${MAX_TASK_CONCURRENCY}`)
  }
  const pct = draft.compactAtPercent
  if (
    pct !== undefined &&
    !(Number.isInteger(pct) && pct >= MIN_COMPACT_AT_PERCENT && pct <= MAX_COMPACT_AT_PERCENT)
  ) {
    throw invalid(
      `compactAtPercent must be a whole number from ${MIN_COMPACT_AT_PERCENT} to ${MAX_COMPACT_AT_PERCENT}`,
      'INVALID_COMPACT_AT',
    )
  }
}

/** A custom context limit must fit the window of the model the agent will use. */
function checkWindow(deps: Deps, def: AgentDef, custom: number | null | undefined): void {
  if (custom === null || custom === undefined) return
  const problem = customWindowProblem(custom, deps.chat.modelOf?.(def).contextWindow)
  if (problem !== undefined) throw invalid(problem, 'INVALID_CONTEXT_WINDOW')
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

/** The Team connector (delegation) belongs to the lead. */
function checkTeam(role: string, connectors: AgentDef['connectors']): void {
  const team = connectors[builtinId('team')]
  if (role !== 'lead' && team !== undefined && team.enabled === 'on') {
    throw invalid('delegate and send_message are only available to the lead agent')
  }
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
  const id =
    draft.id !== undefined && draft.id !== '' && deps.agents.get(draft.id) === undefined
      ? draft.id
      : deps.ids.next()
  const def: AgentDef = {
    id,
    workspaceId: deps.workspaceId,
    slug,
    name: draft.name.trim(),
    role,
    avatar: draft.avatar ?? null,
    color: draft.color ?? (COLORS[deps.agents.count() % COLORS.length] as string),
    description: draft.description ?? '',
    instructions: draft.instructions,
    ...pick(deps, draft.modelProfile, draft.model),
    toolAccess: draft.toolAccess ?? null,
    taskConcurrency: draft.taskConcurrency ?? DEFAULT_TASK_CONCURRENCY,
    contextWindow: draft.contextWindow ?? null,
    compactAtPercent: draft.compactAtPercent ?? DEFAULT_COMPACT_AT_PERCENT,
    skills: draft.skills ?? [],
    permissionMode: draft.permissionMode ?? 'default',
    connectors:
      draft.connectors === undefined
        ? enablementFromTools(
            draft.toolset ?? DEFAULT_LEGACY_TOOLS,
            { id, role },
            { workspaceMemoryWrite: true },
          )
        : normalizeConnectors(draft.connectors),
    rules: { allow: [], ask: [], deny: [], ...draft.rules },
    version: 1,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  }
  checkTeam(role, def.connectors)
  checkWindow(deps, def, def.contextWindow)
  deps.agents.insert(def)
  // the instructions become the first persona version (identity, voice, operating rules)
  ensurePersona(deps, def)
  return def
}

export type AgentPatch = Partial<Omit<AgentDraft, 'role' | 'slug'>> & { version?: number }

/** Edit a definition: bumps `version`, so sessions pick it up on their next turn. */
export function updateAgent(deps: Deps, id: string, patch: AgentPatch): AgentDef {
  const current = getAgent(deps, id)
  if (current.archivedAt !== null) throw conflict('the agent is archived', 'ARCHIVED')
  if (patch.version !== undefined && patch.version !== current.version) {
    throw conflict('the agent was changed concurrently; reload and retry', 'VERSION_CONFLICT')
  }
  const merged: AgentDraft = {
    name: patch.name ?? current.name,
    instructions: patch.instructions ?? current.instructions,
    permissionMode: patch.permissionMode ?? current.permissionMode,
    ...(patch.taskConcurrency === undefined ? {} : { taskConcurrency: patch.taskConcurrency }),
    ...(patch.compactAtPercent === undefined ? {} : { compactAtPercent: patch.compactAtPercent }),
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
    toolAccess: patch.toolAccess === undefined ? current.toolAccess : patch.toolAccess,
    taskConcurrency: patch.taskConcurrency ?? current.taskConcurrency,
    contextWindow: patch.contextWindow === undefined ? current.contextWindow : patch.contextWindow,
    compactAtPercent: patch.compactAtPercent ?? current.compactAtPercent,
    skills: patch.skills ?? current.skills,
    connectors:
      patch.connectors === undefined ? current.connectors : normalizeConnectors(patch.connectors),
    permissionMode: patch.permissionMode ?? current.permissionMode,
    rules:
      patch.rules === undefined ? current.rules : { allow: [], ask: [], deny: [], ...patch.rules },
    version: current.version + 1,
    updatedAt: deps.clock.now(),
  }
  checkTeam(next.role, next.connectors)
  // only a limit set now is checked: a stored one that a model switch left above the new window is
  // clamped when the agent is built (`effectiveWindow`), not rejected
  checkWindow(deps, next, patch.contextWindow)
  if (!deps.agents.update(next, current.version, { connectors: patch.connectors !== undefined })) {
    throw conflict('the agent was changed concurrently; reload and retry', 'VERSION_CONFLICT')
  }
  // the old `instructions` field maps into a new persona version (voice and operating rules)
  if (patch.instructions !== undefined && patch.instructions !== current.instructions) {
    personaFromInstructions(deps, next)
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
