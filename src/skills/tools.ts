/**
 * The skill tools `load_skill`, `read_skill_file` and `search_skills` (spec 07 §4.3), the
 * `skill.load` hook chain, and the model-visible output formats.
 *
 * Expected failures are returned as `ERROR: …` strings, never thrown (CLAUDE.md rule 6). A path
 * that fails `validateSkillPath` never reaches `SkillSource.readFile` (spec 07 §5).
 *
 * @see docs/specs/07-skills.md#43-tools-added-automatically-when-any-skill-exists
 */
import { jsonSchema, type Tool, tool } from 'ai'
import type { HarnessWarning } from '../errors.ts'
import type { HarnessContext } from '../plugin/types.ts'
import type { SkillDoc, SkillFileContent, SkillMeta } from '../registry/types.ts'
import { hookFailed } from '../registry/wrap.ts'
import type { HookRunner } from '../session/hooks.ts'
import { serializeFrontmatter } from './frontmatter.ts'
import { validateSkillPath } from './paths.ts'
import type { SkillSourceEntry, TurnSkills } from './registry.ts'

/** Maximum number of `search_skills` matches. */
export const MAX_SKILL_SEARCH_RESULTS = 10

/** `search_skills` output without matches (model-visible). */
export const NO_SKILLS_MATCH = 'No skills match.'

/** Dependencies of the skill tools. */
export interface SkillToolDeps {
  skills: TurnSkills
  hooks: HookRunner
  contextOf(owner: string): HarnessContext
  warn(warning: HarnessWarning, key?: string): void
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `ERROR: skill "x" not found` (model-visible). */
export function skillNotFound(name: string): string {
  return `ERROR: skill ${JSON.stringify(name)} not found`
}

function isDoc(value: unknown): value is SkillDoc {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as SkillDoc).content === 'string' &&
    Array.isArray((value as SkillDoc).manifest)
  )
}

function isFileContent(value: unknown): value is SkillFileContent {
  if (typeof value !== 'object' || value === null) return false
  const v = value as { type?: unknown; text?: unknown; mediaType?: unknown; data?: unknown }
  if (v.type === 'text') return typeof v.text === 'string'
  return v.type === 'binary' && typeof v.mediaType === 'string' && v.data instanceof Uint8Array
}

/**
 * Format a loaded skill for the model: frontmatter summary (`name`, `description`, extra meta),
 * the body, a `Files:` list (sorted, sizes in bytes when known) and hook notes, separated by
 * blank lines.
 */
export function formatSkillDoc(name: string, doc: SkillDoc, notes: readonly string[]): string {
  const front: Record<string, unknown> = { name, description: doc.description }
  const meta = doc.meta
  const plainMeta =
    typeof meta === 'object' &&
    meta !== null &&
    !Array.isArray(meta) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(meta))
  for (const [key, value] of Object.entries(plainMeta ? meta : {})) {
    if (key !== 'name' && key !== 'description') front[key] = value
  }
  const sections = [`---\n${serializeFrontmatter(front)}\n---\n${doc.content.trim()}`.trimEnd()]
  const files = new Map<string, number | undefined>()
  for (const item of doc.manifest) {
    const path = (item as { path?: unknown } | null)?.path
    if (typeof path !== 'string') continue
    const checked = validateSkillPath(path)
    if (!checked.ok || files.has(checked.path)) continue
    const size = (item as { size?: unknown }).size
    files.set(checked.path, typeof size === 'number' && Number.isFinite(size) ? size : undefined)
  }
  if (files.size > 0) {
    const lines = [...files.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, size]) => `- ${path}${size === undefined ? '' : ` (${size} bytes)`}`)
    sections.push(['Files:', ...lines].join('\n'))
  }
  for (const note of notes) if (note.trim().length > 0) sections.push(note.trim())
  return sections.join('\n\n')
}

/** Format a supporting file for the model (binary files as a placeholder line). */
export function formatSkillFile(content: SkillFileContent): string {
  return content.type === 'text'
    ? content.text
    : `[binary ${content.mediaType}, ${content.data.byteLength} bytes]`
}

/** `SkillSource.locate(name)` for the `skill.load` event; failures warn and yield `undefined`. */
async function locate(
  deps: SkillToolDeps,
  entry: SkillSourceEntry,
  name: string,
): Promise<{ service: string; root: string } | undefined> {
  if (typeof entry.source.locate !== 'function') return undefined
  try {
    const location: unknown = await entry.source.locate(name, deps.contextOf(entry.owner))
    if (location === null || location === undefined) return undefined
    const { service, root } = location as { service?: unknown; root?: unknown }
    if (typeof service !== 'string' || typeof root !== 'string') {
      throw new Error('locate() must return null or { service, root }')
    }
    return { service, root }
  } catch (error) {
    deps.warn(
      {
        code: 'W_SKILL_SOURCE_FAILED',
        message: `Skill source '${entry.source.id}' failed to locate skill '${name}': ${describe(error)}`,
        details: { source: entry.source.id, owner: entry.owner, skill: name },
      },
      `${entry.source.id}:locate`,
    )
    return undefined
  }
}

/**
 * Load a skill of the turn: `SkillSource.load`, then the `skill.load` hook chain (plugin order;
 * the event carries `SkillSource.locate()`'s result; a hook may replace the doc and add notes; a
 * throwing hook is skipped with `W_HOOK_FAILED`).
 * Returns the model-visible text.
 */
export async function loadSkillText(deps: SkillToolDeps, name: string): Promise<string> {
  const entry = deps.skills.sourceOf(name)
  if (entry === undefined) return skillNotFound(name)
  let doc: unknown
  try {
    doc = await entry.source.load(name, deps.contextOf(entry.owner))
  } catch (error) {
    return `ERROR: skill ${JSON.stringify(name)} could not be loaded: ${describe(error)}`
  }
  if (doc === null || doc === undefined) return skillNotFound(name)
  if (!isDoc(doc)) {
    return `ERROR: skill ${JSON.stringify(name)} could not be loaded: the source returned an invalid document`
  }
  let current: SkillDoc = doc
  if (typeof current.description !== 'string') {
    const listed = deps.skills.entries.find((e) => e.name === name)
    current = { ...current, description: listed?.description ?? '' }
  }
  const notes: string[] = []
  const hooks = deps.hooks.list('skill.load')
  const location = hooks.length > 0 ? await locate(deps, entry, name) : undefined
  for (const hook of hooks) {
    try {
      const out = await hook.fn(deps.contextOf(hook.owner), {
        skill: current,
        source: entry.source.id,
        ...(location === undefined ? {} : { location }),
      })
      if (out === undefined || out === null) continue
      if (out.skill !== undefined) {
        if (!isDoc(out.skill)) throw new Error('skill.load returned an invalid `skill`')
        current = out.skill
      }
      for (const note of out.notes ?? []) if (typeof note === 'string') notes.push(note)
    } catch (error) {
      hookFailed(deps, 'skill.load', hook.owner, error)
    }
  }
  try {
    return formatSkillDoc(name, current, notes)
  } catch (error) {
    return `ERROR: skill ${JSON.stringify(name)} could not be loaded: ${describe(error)}`
  }
}

/** Read a supporting file of a skill of the turn. Returns the model-visible text. */
export async function readSkillFileText(
  deps: SkillToolDeps,
  name: string,
  path: string,
): Promise<string> {
  const entry = deps.skills.sourceOf(name)
  if (entry === undefined) return skillNotFound(name)
  const checked = validateSkillPath(path)
  if (!checked.ok) return `ERROR: invalid path: ${checked.error}`
  let content: unknown
  try {
    content = await entry.source.readFile(name, checked.path, deps.contextOf(entry.owner))
  } catch (error) {
    return `ERROR: file ${JSON.stringify(checked.path)} of skill ${JSON.stringify(name)} could not be read: ${describe(error)}`
  }
  if (content === null || content === undefined) {
    return `ERROR: file ${JSON.stringify(checked.path)} not found in skill ${JSON.stringify(name)}`
  }
  if (!isFileContent(content)) {
    return `ERROR: file ${JSON.stringify(checked.path)} of skill ${JSON.stringify(name)} could not be read: the source returned an invalid result`
  }
  return formatSkillFile(content)
}

/** Lowercase word tokens of a text. */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
}

/**
 * Search the skills of the turn: sources with `search()` are asked (results limited to their own
 * resolved skills), the others are matched with a case-insensitive token match over name and
 * description. Ranked by the number of matching query tokens (ties keep source order, then the
 * source's result order or name order); at most 10 matches.
 */
export async function searchSkillsText(deps: SkillToolDeps, query: string): Promise<string> {
  const queryTokens = [...new Set(tokens(query))]
  const score = (meta: SkillMeta) => {
    const haystack = `${meta.name} ${meta.description}`.toLowerCase()
    return queryTokens.filter((t) => haystack.includes(t)).length
  }
  const bySource = new Map<SkillSourceEntry, SkillMeta[]>()
  for (const meta of deps.skills.entries) {
    const entry = deps.skills.sourceOf(meta.name)
    if (entry === undefined) continue
    const list = bySource.get(entry) ?? []
    list.push(meta)
    bySource.set(entry, list)
  }
  const hits: Array<{ meta: SkillMeta; score: number }> = []
  for (const entry of deps.skills.sources) {
    const own = bySource.get(entry)
    if (own === undefined) continue
    const search = entry.source.search
    if (typeof search === 'function' && query.trim().length > 0) {
      try {
        const found = await search.call(entry.source, query, deps.contextOf(entry.owner))
        if (!Array.isArray(found)) throw new Error('search() must return an array')
        const ownByName = new Map(own.map((m) => [m.name, m]))
        const seen = new Set<string>()
        for (const item of found as unknown[]) {
          const name = (item as { name?: unknown } | null)?.name
          if (typeof name !== 'string' || seen.has(name)) continue
          const meta = ownByName.get(name)
          if (meta === undefined) continue
          seen.add(name)
          hits.push({ meta, score: Math.max(1, score(meta)) })
        }
        continue
      } catch (error) {
        deps.warn(
          {
            code: 'W_SKILL_SOURCE_FAILED',
            message: `Skill source '${entry.source.id}' failed to search: ${describe(error)}; using the built-in matcher.`,
            details: { source: entry.source.id, owner: entry.owner },
          },
          `${entry.source.id}:search`,
        )
      }
    }
    for (const meta of own) {
      const s = score(meta)
      if (s > 0) hits.push({ meta, score: s })
    }
  }
  const ranked = hits
    .map((hit, index) => ({ ...hit, index }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, MAX_SKILL_SEARCH_RESULTS)
  if (ranked.length === 0) return NO_SKILLS_MATCH
  return ranked
    .map(({ meta }) => `- ${meta.name}: ${meta.description.replace(/\s+/g, ' ').trim()}`)
    .join('\n')
}

const stringField = (value: unknown, key: string): string | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' ? field : undefined
}

/**
 * The skill tools of one turn, in stable order (spec 02 §6 rule 1): `load_skill` and
 * `read_skill_file` whenever the session has a skill source (static skills count), `search_skills`
 * when the session can reach search mode. Presence never depends on what one turn resolves.
 */
export function createSkillTools(deps: SkillToolDeps): Array<{ name: string; tool: Tool }> {
  if (!deps.skills.hasTools) return []
  const out: Array<{ name: string; tool: Tool }> = [
    {
      name: 'load_skill',
      tool: tool({
        description:
          'Open a skill by name. Returns its instructions and the list of its supporting files.',
        inputSchema: jsonSchema<{ name: string }>({
          type: 'object',
          properties: { name: { type: 'string', description: 'Skill name.' } },
          required: ['name'],
          additionalProperties: false,
        }),
        execute: async (input) => {
          const name = stringField(input, 'name')
          if (name === undefined) return 'ERROR: `name` must be a string'
          return loadSkillText(deps, name)
        },
      }) as Tool,
    },
    {
      name: 'read_skill_file',
      tool: tool({
        description:
          'Read one supporting file of a skill. `path` is relative to the skill, as listed by load_skill.',
        inputSchema: jsonSchema<{ name: string; path: string }>({
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Skill name.' },
            path: { type: 'string', description: 'File path relative to the skill.' },
          },
          required: ['name', 'path'],
          additionalProperties: false,
        }),
        execute: async (input) => {
          const name = stringField(input, 'name')
          const path = stringField(input, 'path')
          if (name === undefined) return 'ERROR: `name` must be a string'
          if (path === undefined) return 'ERROR: `path` must be a string'
          return readSkillFileText(deps, name, path)
        },
      }) as Tool,
    },
  ]
  if (deps.skills.hasSearch) {
    out.push({
      name: 'search_skills',
      tool: tool({
        description: `Search the available skills by keywords. Returns up to ${MAX_SKILL_SEARCH_RESULTS} matches as "- name: description" lines.`,
        inputSchema: jsonSchema<{ query: string }>({
          type: 'object',
          properties: { query: { type: 'string', description: 'Keywords.' } },
          required: ['query'],
          additionalProperties: false,
        }),
        execute: async (input) => {
          const query = stringField(input, 'query')
          if (query === undefined) return 'ERROR: `query` must be a string'
          return searchSkillsText(deps, query)
        },
      }) as Tool,
    })
  }
  return out
}
