/**
 * The skill registry of one turn (internal): source ordering, `list()` caching per `refresh`
 * period, validation, collisions, the index blocks (spec 07 §4.1) and search mode (§4.2).
 *
 * The resolved set is locked for the turn (spec 02 §7): the skill tools only address skills of
 * this set, so a skill added to a source mid-turn appears at the next turn.
 *
 * @see docs/specs/07-skills.md#6-registry-collisions-refresh
 */
import type { HarnessWarning } from '../errors.ts'
import type { HarnessContext } from '../plugin/types.ts'
import type { Skill, SkillMeta, SkillSource } from '../registry/types.ts'
import { skillMetaError } from './define.ts'
import { staticSkillSource } from './static-source.ts'

/** A skill source of the session, in registry order, with its owner. */
export interface SkillSourceEntry {
  owner: string
  source: SkillSource
  /** True for the in-memory source of static skills (index in system block 1). */
  static: boolean
}

/** Per-session skill state (lives in `OpenSession.skills`). */
export interface SessionSkills {
  /** Sources in registry order (spec 07 §6). */
  sources: SkillSourceEntry[]
  /** `list()` results of `refresh: 'session'` sources. */
  cache: Map<SkillSource, SkillMeta[]>
  /** `config.skillsIndexLimit` (default 50; `Infinity` = never search). */
  indexLimit: number
  /** `load_skill` / `read_skill_file` exist: at least one skill source (static skills count). */
  hasTools: boolean
  /** `search_skills` exists (decided once per session, spec 07 §4.3). */
  hasSearch: boolean
}

/**
 * Level-1 entry of the turn's registry.
 *
 * @see docs/specs/02-context-registry.md#8-registry-api-internal-but-tested
 */
export type SkillIndexEntry = SkillMeta & { source: string }

/** Default of `config.skillsIndexLimit`. */
export const DEFAULT_SKILLS_INDEX_LIMIT = 50

/** Header of the skills block (model-visible, api-stability.md). */
export const SKILLS_INDEX_HEADER = '# Skills'

/** Intro line of the skills index (model-visible). */
export const SKILLS_INDEX_INTRO: string =
  'Skills are playbooks you can open when relevant. Open one with load_skill(name) before doing the\n' +
  'task it covers; read its files with read_skill_file(name, path) only when the skill tells you to.'

/** Header of the dynamic part of the index when static skills are listed in block 1. */
export const SKILLS_INDEX_MORE_HEADER = '# More skills'

/** One-line hint that replaces the index in search mode (model-visible). */
export const SKILLS_SEARCH_HINT: string =
  'Skills are playbooks you can open when relevant. Find them with search_skills(query), then open one with load_skill(name) before doing the task it covers.'

/** Hint in block 2 when static skills are indexed in block 1 but the total exceeds the limit. */
export const SKILLS_SEARCH_MORE_HINT: string =
  'More skills are available: find them with search_skills(query), then open one with load_skill(name).'

/** The resolved skills of one turn. */
export interface TurnSkills {
  /** Sorted by name. */
  entries: SkillIndexEntry[]
  /** `'none'` without skills; `'search'` above `indexLimit`. */
  mode: 'none' | 'index' | 'search'
  /** Appended to system block 1 (static sources). */
  staticText: string | undefined
  /** Appended to system block 2 (dynamic sources). */
  dynamicText: string | undefined
  /** Source entry of each resolved skill. */
  sourceOf(name: string): SkillSourceEntry | undefined
  /** All sources of the session, in registry order. */
  sources: readonly SkillSourceEntry[]
  /** Session-level tool presence (see {@link SessionSkills}). */
  hasTools: boolean
  hasSearch: boolean
}

/**
 * Build the session's skill sources in registry order (spec 07 §6): per plugin (root first), its
 * static skills (one in-memory source `static:<owner>`), then its sources. Inputs are already in
 * plugin order (setup before session contributions).
 */
export function buildSessionSkills(
  skills: ReadonlyArray<{ owner: string; skill: Skill }>,
  sources: ReadonlyArray<{ owner: string; source: SkillSource }>,
  pluginOrder: readonly string[],
  indexLimit: number | undefined,
): SessionSkills {
  const out: SkillSourceEntry[] = []
  for (const owner of pluginOrder) {
    const own = skills.filter((s) => s.owner === owner).map((s) => s.skill)
    if (own.length > 0) {
      out.push({ owner, source: staticSkillSource(`static:${owner}`, own), static: true })
    }
    for (const entry of sources) {
      if (entry.owner === owner) out.push({ owner, source: entry.source, static: false })
    }
  }
  const limit =
    typeof indexLimit === 'number' && !Number.isNaN(indexLimit) && indexLimit >= 0
      ? Math.floor(indexLimit)
      : DEFAULT_SKILLS_INDEX_LIMIT
  return {
    sources: out,
    cache: new Map(),
    indexLimit: limit,
    hasTools: out.length > 0,
    hasSearch:
      Number.isFinite(limit) && (skills.length > limit || out.some((entry) => !entry.static)),
  }
}

/** Collapse whitespace so one skill is one index line. */
export function indexLine(meta: SkillMeta): string {
  return `- ${meta.name}: ${meta.description.replace(/\s+/g, ' ').trim()}`
}

const byName = (a: { name: string }, b: { name: string }) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Resolve the skills of one turn: list every source (cached per `refresh`), validate the
 * metadata (`W_INVALID_SKILL`), drop later duplicates (`W_SHADOWED`, first source wins), and build
 * the index texts or the search hint.
 */
export async function resolveTurnSkills(args: {
  skills: SessionSkills
  contextOf: (owner: string) => HarnessContext
  warn: (warning: HarnessWarning, key?: string) => void
}): Promise<TurnSkills> {
  const { skills, contextOf, warn } = args
  const winners = new Map<string, { meta: SkillMeta; entry: SkillSourceEntry }>()
  // static skills always win over dynamic sources (spec 02 §7): resolve them first
  const ordered = [
    ...skills.sources.filter((s) => s.static),
    ...skills.sources.filter((s) => !s.static),
  ]
  for (const entry of ordered) {
    const { source, owner } = entry
    let listed = source.refresh === 'turn' ? undefined : skills.cache.get(source)
    if (listed === undefined) {
      let raw: unknown
      try {
        raw = await source.list(contextOf(owner))
        if (!Array.isArray(raw)) throw new Error('list() must return an array')
      } catch (error) {
        warn(
          {
            code: 'W_SKILL_SOURCE_FAILED',
            message: `Skill source '${source.id}' failed to list its skills: ${describe(error)}`,
            details: { source: source.id, owner },
          },
          source.id,
        )
        continue
      }
      listed = []
      for (const item of raw as unknown[]) {
        const error = skillMetaError(item)
        if (error !== undefined) {
          const name = (item as { name?: unknown } | null)?.name
          warn(
            {
              code: 'W_INVALID_SKILL',
              message: `Skill source '${source.id}' listed an invalid skill (${error}); skipped.`,
              details: { source: source.id, skill: typeof name === 'string' ? name : undefined },
            },
            `${source.id}:${String(name)}`,
          )
          continue
        }
        const meta = item as SkillMeta
        const copy: SkillMeta = { name: meta.name, description: meta.description }
        if (meta.meta !== undefined) copy.meta = meta.meta
        listed.push(copy)
      }
      if (source.refresh !== 'turn') skills.cache.set(source, listed)
    }
    for (const meta of listed) {
      const existing = winners.get(meta.name)
      if (existing !== undefined) {
        warn(
          {
            code: 'W_SHADOWED',
            message: `Skill '${meta.name}' from source '${source.id}' is hidden by the skill with the same name from source '${existing.entry.source.id}'.`,
            details: { skill: meta.name, source: source.id, winner: existing.entry.source.id },
          },
          `${source.id}:${meta.name}`,
        )
        continue
      }
      winners.set(meta.name, { meta, entry })
    }
  }

  const entries: SkillIndexEntry[] = [...winners.values()]
    .map(({ meta, entry }) => ({ ...meta, source: entry.source.id }))
    .sort(byName)
  const statics = entries.filter((e) => winners.get(e.name)?.entry.static === true)
  const dynamics = entries.filter((e) => winners.get(e.name)?.entry.static !== true)

  const limit = skills.indexLimit
  const mode: TurnSkills['mode'] =
    entries.length === 0 ? 'none' : entries.length > limit ? 'search' : 'index'
  // block 1 depends on static skills only (stable for the session)
  let staticText: string | undefined
  if (statics.length > limit) staticText = `${SKILLS_INDEX_HEADER}\n${SKILLS_SEARCH_HINT}`
  else if (statics.length > 0) {
    staticText = [`${SKILLS_INDEX_HEADER}\n${SKILLS_INDEX_INTRO}`, ...statics.map(indexLine)].join(
      '\n',
    )
  }
  // block 2: the dynamic part, or the search hint when everything together exceeds the limit
  let dynamicText: string | undefined
  if (statics.length <= limit && dynamics.length > 0) {
    if (mode === 'search') {
      dynamicText =
        statics.length > 0
          ? `${SKILLS_INDEX_MORE_HEADER}\n${SKILLS_SEARCH_MORE_HINT}`
          : `${SKILLS_INDEX_HEADER}\n${SKILLS_SEARCH_HINT}`
    } else {
      dynamicText = [
        statics.length > 0
          ? SKILLS_INDEX_MORE_HEADER
          : `${SKILLS_INDEX_HEADER}\n${SKILLS_INDEX_INTRO}`,
        ...dynamics.map(indexLine),
      ].join('\n')
    }
  }

  return {
    entries,
    mode,
    staticText,
    dynamicText,
    sources: skills.sources,
    hasTools: skills.hasTools,
    hasSearch: skills.hasSearch,
    sourceOf: (name) => winners.get(name)?.entry,
  }
}
