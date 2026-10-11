import type { Database } from 'bun:sqlite'
import { BUILTIN_SKILLS, skillPath } from '../../domain/builtin-skills.ts'
import { libraryFs } from '../eh/library-fs.ts'

/** Store the built-in skills the first time; an existing file (maybe edited) is left alone. */
export async function seedBuiltinSkills(sqlite: Database): Promise<number> {
  const fs = libraryFs(sqlite)
  let created = 0
  for (const skill of BUILTIN_SKILLS) {
    const written = await fs.write(skillPath(skill.name), skill.content, { ifVersion: null })
    if (written.ok) created++
  }
  return created
}
