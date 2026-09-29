/**
 * Skill-relative addressing (spec 07 §5, ADR-0006): the canonical address of a skill file is
 * `(skillName, relativePath)`; the model never sees a filesystem path.
 *
 * @see docs/specs/07-skills.md#5-addressing-normative
 */

/** Maximum length of a skill-relative path (characters). */
export const MAX_SKILL_PATH_LENGTH = 512

/**
 * Validate a skill-relative path (spec 07 §5).
 *
 * Rules: POSIX separators, no leading `/`, no `..` segment, no `\`, no NUL, no empty segments
 * (so no `//` and no trailing `/`), at most 512 characters, and not `SKILL.md` itself (compared
 * case-insensitively; open the body with `load_skill`). `.` segments are removed; the result is
 * the normalized path.
 *
 * Sources receive only paths that passed this check. Returns the normalized path or a short
 * reason (for `ERROR: invalid path: <reason>`).
 *
 * @example
 * ```ts
 * validateSkillPath('./scripts/check.py') // { ok: true, path: 'scripts/check.py' }
 * validateSkillPath('../secrets')         // { ok: false, error: "'..' segments are not allowed" }
 * ```
 * @see docs/specs/07-skills.md#5-addressing-normative
 */
export function validateSkillPath(
  path: string,
): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof path !== 'string') return { ok: false, error: 'the path must be a string' }
  if (path.length === 0) return { ok: false, error: 'the path is empty' }
  if (path.length > MAX_SKILL_PATH_LENGTH) {
    return { ok: false, error: `the path is longer than ${MAX_SKILL_PATH_LENGTH} characters` }
  }
  if (path.includes('\u0000')) return { ok: false, error: 'the path contains a NUL character' }
  if (path.includes('\\')) return { ok: false, error: "use '/' as separator, not '\\'" }
  if (path.startsWith('/')) {
    return { ok: false, error: 'the path must be relative to the skill (no leading /)' }
  }
  const segments = path.split('/')
  const kept: string[] = []
  for (const segment of segments) {
    if (segment === '') return { ok: false, error: 'the path contains an empty segment' }
    if (segment === '..') return { ok: false, error: "'..' segments are not allowed" }
    if (segment === '.') continue
    kept.push(segment)
  }
  if (kept.length === 0) return { ok: false, error: 'the path does not name a file' }
  const normalized = kept.join('/')
  if (normalized.toLowerCase() === 'skill.md') {
    return { ok: false, error: 'SKILL.md is not a supporting file; open it with load_skill' }
  }
  return { ok: true, path: normalized }
}
