/**
 * Lexical POSIX path helpers and a gitignore-style matcher. Pure string logic: nothing here
 * touches a file system, reads the environment or imports a Node built-in (spec 18 §5).
 */

import { collapseSegments, compileGitignorePattern, escapeRegExp, foldSegment } from '../index.ts'

export { escapeRegExp, foldSegment }

/** Normalise a POSIX path lexically: collapse `//`, `.` and `..` (an absolute path stops at `/`). */
export function normalize(path: string): string {
  const absolute = path.startsWith('/')
  const joined = collapseSegments(path.split('/'), { keepLeadingDotDot: !absolute }).join('/')
  if (absolute) return `/${joined}`
  return joined === '' ? '.' : joined
}

/** True for a path that starts with `/`. */
export function isAbsolute(path: string): boolean {
  return path.startsWith('/')
}

/** Join and normalise path parts. */
export function join(...parts: string[]): string {
  return normalize(parts.filter((p) => p !== '').join('/'))
}

/** Resolve `path` against the absolute directory `base` (an absolute `path` wins). */
export function resolve(base: string, path: string): string {
  return path.startsWith('/') ? normalize(path) : normalize(`${base}/${path}`)
}

/** The path of `to` relative to `from` (both absolute and normalised). */
export function relative(from: string, to: string): string {
  const a = normalize(from).split('/').filter(Boolean)
  const b = normalize(to).split('/').filter(Boolean)
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return [...Array<string>(a.length - i).fill('..'), ...b.slice(i)].join('/')
}

/** True when `path` is `dir` or below it (absolute, normalised paths). */
export function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path)
  return rel === '' || (rel !== '..' && !rel.startsWith('../'))
}

// ─── gitignore-style matching ────────────────────────────────────────────────────────────────

/** A compiled gitignore pattern. */
export interface IgnorePattern {
  /** A trailing `/`: only directories (here: parents of the tested path) match. */
  dirOnly: boolean
  regex: RegExp
  /** Case-insensitive, NFC-normalised, trailing dots and spaces of a segment ignored (`.git.` is `.git`). */
  ci?: boolean
}

/**
 * Compile one gitignore pattern. Returns `undefined` for a blank pattern, a comment (`#`) and a
 * negation (`!`): rules never un-match.
 *
 * - a pattern without a `/` (except a trailing one) matches at any depth;
 * - a pattern with a `/` is anchored at the base directory (a leading `/` is dropped);
 * - a trailing `/` matches directories only; `**` matches any number of directories;
 * - `*` and `?` never match a `/` and, unlike a shell, do match a leading dot.
 */
export function compilePattern(pattern: string, ci = false): IgnorePattern | undefined {
  const line = compileGitignorePattern(pattern, { caseFold: ci })
  if (line === undefined || line.negate) return undefined
  return ci
    ? { dirOnly: line.dirOnly, regex: line.regex, ci: true }
    : { dirOnly: line.dirOnly, regex: line.regex }
}

/**
 * Whether a relative path is matched by the pattern: the path itself or any of its parent
 * directories (matching a directory covers everything below it).
 */
export function patternMatches(compiled: IgnorePattern, relPath: string): boolean {
  const raw = relPath.split('/').filter((s) => s !== '')
  const segments = compiled.ci === true ? raw.map(foldSegment) : raw
  const last = compiled.dirOnly ? segments.length - 1 : segments.length
  for (let i = 1; i <= last; i++) {
    if (compiled.regex.test(segments.slice(0, i).join('/'))) return true
  }
  return false
}

const cache = new Map<string, IgnorePattern | null>()

/** Compile with a cache (rules are matched on every call). `ci`: see {@link IgnorePattern.ci}. */
export function cachedPattern(pattern: string, ci = false): IgnorePattern | undefined {
  const key = `${ci ? 'i' : 's'}:${pattern}`
  let compiled = cache.get(key)
  if (compiled === undefined) {
    compiled = compilePattern(pattern, ci) ?? null
    if (cache.size > 2000) cache.clear()
    cache.set(key, compiled)
  }
  return compiled ?? undefined
}

/** A matcher for a list of gitignore patterns (a path matches when any pattern does). */
export function ignoreMatcher(
  patterns: readonly string[],
  ci = false,
): (relPath: string) => boolean {
  const compiled = patterns
    .map((p) => cachedPattern(p, ci))
    .filter((c): c is IgnorePattern => c !== undefined)
  return (relPath) => compiled.some((c) => patternMatches(c, relPath))
}
