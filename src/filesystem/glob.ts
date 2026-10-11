/**
 * A small glob matcher for the `glob` tool (spec 08 §3): `**`, `*`, `?`, `[abc]` / `[!abc]` /
 * `[a-z]` and `{a,b}`. Matching is over `/`-separated relative paths. A segment that does not
 * start with a literal `.` never matches a name that starts with one (dotfiles). Compiled by the
 * shared core glob compiler, which also collapses consecutive `**` and caps the wildcards.
 *
 * @see docs/specs/08-filesystem-plugin.md#3-tools
 */

import { compileGlobRegExp } from '../index.ts'

/** Longest pattern accepted. */
const MAX_PATTERN_LENGTH = 512

/** Result of {@link compileGlob}. */
export type CompiledGlob = { ok: true; test(path: string): boolean } | { ok: false; error: string }

/** Why a pattern may not be used, or `undefined`. */
export function globPatternProblem(pattern: string): string | undefined {
  if (pattern === '') return 'the pattern is empty'
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return `the pattern is longer than ${MAX_PATTERN_LENGTH} characters`
  }
  if (pattern.includes('\\')) return 'the pattern may not contain backslashes; use "/"'
  if (pattern.includes('\0')) return 'the pattern may not contain NUL'
  if (pattern.startsWith('/') || pattern.startsWith('~')) {
    return 'the pattern must be relative to `path` (no leading "/" or "~")'
  }
  if (pattern.split('/').includes('..')) return 'the pattern may not contain ".."'
  return undefined
}

/**
 * Compile a glob. `test(path)` takes a relative path with `/` separators (no leading `/`).
 * Invalid patterns return `{ ok: false, error }` (never throw).
 */
export function compileGlob(pattern: string): CompiledGlob {
  const problem = globPatternProblem(pattern)
  if (problem !== undefined) return { ok: false, error: problem }
  const compiled = compileGlobRegExp(pattern, { dot: false })
  if (!compiled.ok) return compiled
  const { regex } = compiled
  return { ok: true, test: (path) => regex.test(path) }
}
