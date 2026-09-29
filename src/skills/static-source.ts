/**
 * In-memory `SkillSource` over static skills (spec 07 §2): static skills take the same code path
 * as dynamic ones.
 *
 * @see docs/specs/07-skills.md#2-static-skills
 */
import type {
  Skill,
  SkillDoc,
  SkillFileContent,
  SkillMeta,
  SkillSource,
} from '../registry/types.ts'

const encoder = new TextEncoder()

function metaOf(skill: Skill): SkillMeta {
  const out: SkillMeta = { name: skill.name, description: skill.description }
  if (skill.meta !== undefined) out.meta = structuredClone(skill.meta)
  return out
}

/**
 * Wrap static skills into a `SkillSource` (`refresh: 'session'`). Every call returns fresh
 * copies; manifests are sorted by path and carry UTF-8 byte sizes.
 *
 * @param id Source id (`static:<owner>` for the skills of one plugin).
 */
export function staticSkillSource(id: string, skills: readonly Skill[]): SkillSource {
  const byName = new Map(skills.map((skill) => [skill.name, skill]))
  return {
    id,
    refresh: 'session',
    list: () => skills.map(metaOf),
    load(name): SkillDoc | null {
      const skill = byName.get(name)
      if (skill === undefined) return null
      const manifest = (skill.files ?? [])
        .map((file) => ({ path: file.path, size: encoder.encode(file.content).byteLength }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      return { ...metaOf(skill), content: skill.content, manifest }
    },
    readFile(name, path): SkillFileContent | null {
      const file = byName.get(name)?.files?.find((f) => f.path === path)
      return file === undefined ? null : { type: 'text', text: file.content }
    },
  }
}
