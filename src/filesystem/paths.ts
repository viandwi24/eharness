/**
 * Path handling of the filesystem plugin (spec 08 §1): normalized absolute POSIX paths and
 * directory-prefix checks for hidden / read-only areas.
 *
 * @see docs/specs/08-filesystem-plugin.md#1-contract
 */

import { foldSegment, HarnessError, MAX_ROOTED_PATH_LENGTH, normalizeRootedPath } from '../index.ts'

/** Maximum length of a normalized path (characters). */
export const MAX_PATH_LENGTH: number = MAX_ROOTED_PATH_LENGTH

/**
 * Normalize a file path to an absolute POSIX path inside the root.
 *
 * Relative paths are resolved from `/`; `//` collapses, `.` segments are removed, `..` goes up
 * one directory and may not leave the root; a trailing `/` is dropped. Rejected: non-strings,
 * empty paths, NUL, `\`, paths escaping the root and paths longer than 4096 characters. Returns
 * the normalized path or a short reason (for `ERROR: invalid path: <reason>`).
 *
 * @example
 * ```ts
 * normalizePath('src//a/../main.pine') // { ok: true, path: '/src/main.pine' }
 * normalizePath('/../etc/passwd')      // { ok: false, error: 'the path escapes the root' }
 * ```
 * @see docs/specs/08-filesystem-plugin.md#1-contract
 */
export function normalizePath(
  path: string,
): { ok: true; path: string } | { ok: false; error: string } {
  return normalizeRootedPath(path)
}

/** True when `path` is `prefix` itself or inside the directory `prefix` (both normalized). */
export function isUnder(path: string, prefix: string): boolean {
  if (prefix === '/') return true
  return path === prefix || path.startsWith(`${prefix}/`)
}

/** True when `path` is under any of `prefixes`. */
export function isUnderAny(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => isUnder(path, prefix))
}

/**
 * Like {@link isUnder}, but compared case-insensitively on NFC-folded segments (also ignoring
 * trailing dots and spaces), for hidden and read-only areas: on a case-insensitive file system
 * `/Secrets` is `/secrets`, and an extra match only hides or protects a little more.
 */
export function isUnderFolded(path: string, prefix: string): boolean {
  if (prefix === '/') return true
  const p = path.split('/').filter(Boolean).map(foldSegment)
  const q = prefix.split('/').filter(Boolean).map(foldSegment)
  return q.length <= p.length && q.every((segment, i) => segment === p[i])
}

/** True when `path` is under any of `prefixes`, compared like {@link isUnderFolded}. */
export function isUnderAnyFolded(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => isUnderFolded(path, prefix))
}

/** Directory form of a normalized path for `FileSystem.list` / `grep` (`'/a'` → `'/a/'`). */
export function dirPrefix(path: string): string {
  return path === '/' ? '/' : `${path}/`
}

/** Join a normalized directory and a relative path (`'/'` root aware). */
export function joinPath(dir: string, relative: string): string {
  return dir === '/' ? `/${relative}` : `${dir}/${relative}`
}

/**
 * Normalize a list of prefixes from options.
 *
 * @throws {TypeError} for an invalid prefix (programmer error in the options).
 */
export function normalizePrefixes(prefixes: readonly string[] | undefined, what: string): string[] {
  const out: string[] = []
  for (const prefix of prefixes ?? []) {
    const result = normalizePath(prefix)
    if (!result.ok)
      throw new HarnessError(
        'EH_CONFIG_INVALID',
        `${what}: invalid prefix ${JSON.stringify(prefix)}: ${result.error}`,
      )
    if (!out.includes(result.path)) out.push(result.path)
  }
  return out
}
