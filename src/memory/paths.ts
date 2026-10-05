/**
 * Path handling of the memory plugin (spec 14 §3).
 *
 * `eharness/memory` imports core only through `src/index.ts` and never another subpath
 * (ADR-0008), so the path rules of `normalizePath` from `eharness/filesystem` (spec 08 §1) are
 * mirrored here; a test keeps both identical.
 *
 * @see docs/specs/14-memory-plugin.md#3-paths-and-roots
 */

const MAX_PATH_LENGTH = 4096

/** Mirror of `normalizePath` from `eharness/filesystem` (spec 08 §1). */
export function normalizeMemoryPath(
  path: string,
): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof path !== 'string') return { ok: false, error: 'the path must be a string' }
  if (path.trim().length === 0) return { ok: false, error: 'the path is empty' }
  if (path.includes('\u0000')) return { ok: false, error: 'the path contains a NUL character' }
  if (path.includes('\\')) return { ok: false, error: "use '/' as separator, not '\\'" }
  const kept: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (kept.length === 0) return { ok: false, error: 'the path escapes the root' }
      kept.pop()
      continue
    }
    kept.push(segment)
  }
  const normalized = `/${kept.join('/')}`
  if (normalized.length > MAX_PATH_LENGTH) {
    return { ok: false, error: `the path is longer than ${MAX_PATH_LENGTH} characters` }
  }
  return { ok: true, path: normalized }
}

/** True when `path` is `dir` itself or inside the directory `dir` (both normalized). */
export function isUnder(path: string, dir: string): boolean {
  if (dir === '/') return true
  return path === dir || path.startsWith(`${dir}/`)
}

/** Directory form of a normalized path (`'/a'` → `'/a/'`, `'/'` stays `'/'`). */
export function dirPrefix(path: string): string {
  return path === '/' ? '/' : `${path}/`
}
