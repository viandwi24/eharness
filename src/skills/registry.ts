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
  /** `config.skillsIndexLimit` (default 50). */
  indexLimit: number
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
  return {
    sources: out,
    cache: new Map(),
    indexLimit:
      typeof indexLimit === 'number' && Number.isFinite(indexLimit) && indexLimit >= 0
        ? Math.floor(indexLimit)
        : DEFAULT_SKILLS_INDEX_LIMIT,
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
  for (const entry of skills.sources) {
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
  const staticNames = new Set(
    [...winners.values()].filter((w) => w.entry.static).map((w) => w.meta.name),
  )

  let mode: TurnSkills['mode'] = 'none'
  let staticText: string | undefined
  let dynamicText: string | undefined
  if (entries.length > skills.indexLimit) {
    mode = 'search'
    const hint = `${SKILLS_INDEX_HEADER}\n${SKILLS_SEARCH_HINT}`
    if (skills.sources.some((s) => !s.static)) dynamicText = hint
    else staticText = hint
  } else if (entries.length > 0) {
    mode = 'index'
    const statics = entries.filter((e) => staticNames.has(e.name)).map(indexLine)
    const dynamics = entries.filter((e) => !staticNames.has(e.name)).map(indexLine)
    const intro = `${SKILLS_INDEX_HEADER}\n${SKILLS_INDEX_INTRO}`
    if (statics.length > 0) staticText = [intro, ...statics].join('\n')
    if (dynamics.length > 0) {
      dynamicText = [statics.length > 0 ? SKILLS_INDEX_MORE_HEADER : intro, ...dynamics].join('\n')
    }
  }

  return {
    entries,
    mode,
    staticText,
    dynamicText,
    sources: skills.sources,
    sourceOf: (name) => winners.get(name)?.entry,
  }
}
