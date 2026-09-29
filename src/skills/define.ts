/**
 * `defineSkill`, `defineSkillSource` and skill metadata validation.
 *
 * @see docs/specs/07-skills.md
 */
import { HarnessError } from '../errors.ts'
import type { Skill, SkillMeta, SkillSource } from '../registry/types.ts'
import { validateSkillPath } from './paths.ts'

/** Valid skill names: lowercase words joined by single hyphens, max 64 chars (spec 07 §1). */
export const SKILL_NAME_PATTERN: RegExp = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** Maximum skill name length. */
export const MAX_SKILL_NAME_LENGTH = 64

/** Maximum description length. */
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024

/** Why `name` is not a valid skill name, or `undefined` when it is. */
export function skillNameError(name: unknown): string | undefined {
  if (typeof name !== 'string') return 'the skill name must be a string'
  if (name.length === 0) return 'the skill name is empty'
  if (name.length > MAX_SKILL_NAME_LENGTH) {
    return `the skill name '${name}' is longer than ${MAX_SKILL_NAME_LENGTH} characters`
  }
  if (!SKILL_NAME_PATTERN.test(name)) {
    return `the skill name '${name}' must match ${String(SKILL_NAME_PATTERN)}`
  }
  return undefined
}

/** Why `description` is not a valid skill description, or `undefined` when it is. */
export function skillDescriptionError(description: unknown): string | undefined {
  if (typeof description !== 'string') return 'the skill description must be a string'
  if (description.trim().length === 0) return 'the skill description is empty'
  if (description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
    return `the skill description is longer than ${MAX_SKILL_DESCRIPTION_LENGTH} characters`
  }
  return undefined
}

/** Why a value is not valid level-1 metadata, or `undefined` when it is. */
export function skillMetaError(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'skill metadata must be an object { name, description }'
  }
  const meta = value as Partial<SkillMeta>
  const error = skillNameError(meta.name) ?? skillDescriptionError(meta.description)
  if (error !== undefined) return error
  if (
    meta.meta !== undefined &&
    (typeof meta.meta !== 'object' || meta.meta === null || Array.isArray(meta.meta))
  ) {
    return `the meta of skill '${String(meta.name)}' must be an object`
  }
  return undefined
}

function invalid(message: string, details: Record<string, unknown>): never {
  throw new HarnessError('EH_CONFIG_INVALID', message, { details })
}

/**
 * Define a static skill. Validates the name (spec 07 §1), the description, the body and every
 * supporting file path (spec 07 §5, no duplicates); throws `EH_CONFIG_INVALID` otherwise.
 *
 * A static skill is served through an in-memory `SkillSource`, so the model cannot tell it apart
 * from a dynamic one.
 *
 * @example
 * ```ts
 * const pine = defineSkill({
 *   name: 'pine-v6',
 *   description: 'Pine Script v6 syntax and pitfalls. Use when writing Pine.',
 *   content: 'Read reference.md before answering.',
 *   files: [{ path: 'reference.md', content: '…' }],
 * })
 * defineHarnessAgent({ model, skills: [pine] })
 * ```
 * @see docs/specs/07-skills.md#2-static-skills
 */
export function defineSkill(skill: Skill): Skill {
  if (typeof skill !== 'object' || skill === null) {
    invalid('defineSkill: expected { name, description, content }.', {})
  }
  const nameError = skillNameError(skill.name)
  if (nameError !== undefined) invalid(`defineSkill: ${nameError}.`, { skill: skill.name })
  const descriptionError = skillDescriptionError(skill.description)
  if (descriptionError !== undefined) {
    invalid(`defineSkill('${skill.name}'): ${descriptionError}.`, { skill: skill.name })
  }
  if (typeof skill.content !== 'string') {
    invalid(`defineSkill('${skill.name}'): \`content\` must be a string.`, { skill: skill.name })
  }
  if (
    skill.meta !== undefined &&
    (typeof skill.meta !== 'object' || skill.meta === null || Array.isArray(skill.meta))
  ) {
    invalid(`defineSkill('${skill.name}'): \`meta\` must be an object.`, { skill: skill.name })
  }
  if (skill.files !== undefined) {
    if (!Array.isArray(skill.files)) {
      invalid(`defineSkill('${skill.name}'): \`files\` must be an array.`, { skill: skill.name })
    }
    const seen = new Set<string>()
    for (const file of skill.files) {
      const path = (file as { path?: unknown } | null)?.path
      if (typeof path !== 'string' || typeof file.content !== 'string') {
        invalid(
          `defineSkill('${skill.name}'): every file needs a string \`path\` and \`content\`.`,
          {
            skill: skill.name,
          },
        )
      }
      const checked = validateSkillPath(path)
      if (!checked.ok) {
        invalid(`defineSkill('${skill.name}'): invalid file path '${path}': ${checked.error}.`, {
          skill: skill.name,
          path,
        })
      }
      if (checked.path !== path) {
        invalid(
          `defineSkill('${skill.name}'): file path '${path}' is not normalized (use '${checked.path}').`,
          { skill: skill.name, path },
        )
      }
      if (seen.has(path)) {
        invalid(`defineSkill('${skill.name}'): file '${path}' is declared twice.`, {
          skill: skill.name,
          path,
        })
      }
      seen.add(path)
    }
  }
  return skill
}

/**
 * Define a dynamic skill source (database, remote catalog, filesystem, …). Validates the shape
 * (`id`, `list`, `load`, `readFile`, optional `search`/`locate`, `refresh`); throws
 * `EH_CONFIG_INVALID` otherwise. Test it with `skillSourceConformance` from `eharness/testing`.
 *
 * @example
 * ```ts
 * const tenantSkills = defineSkillSource({
 *   id: 'db:tenant-skills',
 *   refresh: 'turn',
 *   list: (ctx) => db.skills.list(ctx.runtime.tenantId),
 *   load: (name, ctx) => db.skills.get(ctx.runtime.tenantId, name),
 *   readFile: (name, path, ctx) => db.skills.file(ctx.runtime.tenantId, name, path),
 * })
 * ```
 * @see docs/specs/07-skills.md#3-dynamic-skills--skillsource
 */
export function defineSkillSource(src: SkillSource): SkillSource {
  if (typeof src !== 'object' || src === null) {
    invalid('defineSkillSource: expected { id, list, load, readFile }.', {})
  }
  if (typeof src.id !== 'string' || src.id.length === 0) {
    invalid('defineSkillSource: `id` must be a non-empty string.', {})
  }
  for (const key of ['list', 'load', 'readFile'] as const) {
    if (typeof src[key] !== 'function') {
      invalid(`defineSkillSource('${src.id}'): \`${key}\` must be a function.`, { source: src.id })
    }
  }
  for (const key of ['search', 'locate'] as const) {
    if (src[key] !== undefined && typeof src[key] !== 'function') {
      invalid(`defineSkillSource('${src.id}'): \`${key}\` must be a function.`, { source: src.id })
    }
  }
  if (src.refresh !== undefined && src.refresh !== 'session' && src.refresh !== 'turn') {
    invalid(`defineSkillSource('${src.id}'): \`refresh\` must be 'session' or 'turn'.`, {
      source: src.id,
    })
  }
  return src
}
