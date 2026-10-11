/**
 * Lexical path helpers shared by the filesystem, memory and permissions modules (one
 * normalisation, three thin wrappers). Pure string logic.
 */

/** Longest normalized rooted path accepted (characters). */
export const MAX_ROOTED_PATH_LENGTH = 4096

/**
 * Collapse path segments lexically: empty and `.` segments are dropped, `..` removes the previous
 * segment. A `..` with nothing to remove is kept (`keepLeadingDotDot: true`, relative paths) or
 * dropped (`false`, a path that stops at its root). With `keepLeadingDotDot: true`, a result that
 * starts with `..` means the path escapes its base.
 *
 * @example
 * ```ts
 * collapseSegments('a//b/../c'.split('/'), { keepLeadingDotDot: false }) // ['a', 'c']
 * collapseSegments('../a'.split('/'), { keepLeadingDotDot: true })       // ['..', 'a']
 * ```
 */
export function collapseSegments(
  parts: readonly string[],
  options: { keepLeadingDotDot: boolean },
): string[] {
  const out: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (options.keepLeadingDotDot) out.push('..')
      continue
    }
    out.push(part)
  }
  return out
}

/**
 * Normalize a path to an absolute POSIX path inside a root (the rules of the filesystem and memory
 * tools, spec 08 §1): relative paths resolve from `/`, `..` may not leave the root. Rejected:
 * non-strings, empty paths, NUL, `\`, escapes and paths over {@link MAX_ROOTED_PATH_LENGTH}
 * characters. Returns the path or a short reason.
 */
export function normalizeRootedPath(
  path: string,
): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof path !== 'string') return { ok: false, error: 'the path must be a string' }
  if (path.trim().length === 0) return { ok: false, error: 'the path is empty' }
  if (path.includes('\u0000')) return { ok: false, error: 'the path contains a NUL character' }
  if (path.includes('\\')) return { ok: false, error: "use '/' as separator, not '\\'" }
  const parts = path.split('/')
  if (collapseSegments(parts, { keepLeadingDotDot: true })[0] === '..') {
    return { ok: false, error: 'the path escapes the root' }
  }
  const normalized = `/${collapseSegments(parts, { keepLeadingDotDot: false }).join('/')}`
  if (normalized.length > MAX_ROOTED_PATH_LENGTH) {
    return { ok: false, error: `the path is longer than ${MAX_ROOTED_PATH_LENGTH} characters` }
  }
  return { ok: true, path: normalized }
}

/**
 * Fold a path segment for a case-insensitive comparison: NFC, lower case, and no trailing dots or
 * spaces (Windows ignores them, so `.git.` and `.git ` name `.git`). Used for protected paths,
 * deny/ask rules and hidden / read-only prefixes, where an extra match only costs an extra
 * question or hides a little more.
 */
export function foldSegment(segment: string): string {
  const folded = segment.normalize('NFC').toLowerCase()
  const trimmed = folded.replace(/[. ]+$/, '')
  return trimmed === '' ? folded : trimmed
}
