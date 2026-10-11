/**
 * `nodeContainsProtected`: the `containsProtected` option of the permission engine (spec 18 §5).
 * Walks a directory below a recursive shell read (`grep -r KEY .`) and reports whether anything in
 * it matches gitignore-style patterns (`.env*`, `**\/secrets.json`, `.git`). Bounded; when a bound
 * is hit the answer is `true` (fail closed). Node-only (ADR-0036).
 */
import type { Dirent } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { compileGitignorePattern, foldSegment } from '../../index.ts'

/** Bounds of {@link nodeContainsProtected}. */
export interface ContainsProtectedLimits {
  /** Deepest level looked into (the directory itself is level 0). Default 32. */
  maxDepth?: number
  /** Most entries (files and directories) looked at in one call. Default 50 000. */
  maxEntries?: number
  /** Time budget of one call in milliseconds. Default 2 000. */
  timeBudgetMs?: number
}

const DEFAULT_MAX_DEPTH = 32
const DEFAULT_MAX_ENTRIES = 50_000
const DEFAULT_TIME_BUDGET_MS = 2_000

/**
 * True when `realDir` (a directory, or a file: its own name is tested) holds a file or directory
 * that matches one of the gitignore-style `patterns`, tested case-insensitively on the path below
 * `realDir`. A pattern with a `/` is anchored in gitignore, but the directory searched is
 * usually below the project root, so such a pattern is also tried at any depth (it can only
 * over-match). Symlinks are tested by their own name and never followed; `node_modules` and `.git`
 * are walked like any directory (a pattern such as `.env*` matches inside them). A missing
 * path or an unreadable subdirectory has no matches. Exceeding a limit, or a pattern that cannot be
 * compiled, answers `true` (fail closed). Honours no `.gitignore`.
 *
 * Pass it as `containsProtected` to `createPermissionEngine`.
 *
 * @param realDir - Absolute real path.
 * @param patterns - Gitignore-style patterns; negations are ignored.
 * @param limits - Bounds of the walk.
 */
export async function nodeContainsProtected(
  realDir: string,
  patterns: readonly string[],
  limits: ContainsProtectedLimits = {},
): Promise<boolean> {
  const maxDepth = limits.maxDepth ?? DEFAULT_MAX_DEPTH
  const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES
  const deadline = Date.now() + (limits.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS)

  const compiled: Array<{ dirOnly: boolean; regex: RegExp }> = []
  for (const raw of patterns) {
    const lines = [raw]
    const body = raw.replace(/\/+$/, '').replace(/^\/+/, '')
    if (!raw.startsWith('!') && body.includes('/') && !body.startsWith('**/')) {
      lines.push(`**/${body}${raw.endsWith('/') ? '/' : ''}`)
    }
    for (const line of lines) {
      const pattern = compileGitignorePattern(line, { caseFold: true })
      if (pattern === undefined) {
        if (line.trim() === '' || line.trimStart().startsWith('#')) continue
        return true // cannot test this pattern
      }
      if (!pattern.negate) compiled.push({ dirOnly: pattern.dirOnly, regex: pattern.regex })
    }
  }
  if (compiled.length === 0) return false

  const matches = (rel: string, isDir: boolean): boolean => {
    const folded = rel.split('/').map(foldSegment).join('/')
    return compiled.some((p) => (!p.dirOnly || isDir) && p.regex.test(folded))
  }

  let seen = 0
  const exhausted = (): boolean => ++seen > maxEntries || Date.now() > deadline

  let start: Awaited<ReturnType<typeof lstat>>
  try {
    start = await lstat(realDir)
  } catch {
    return false
  }
  if (!start.isDirectory()) return matches(basename(realDir), false)

  // breadth-first, so a shallow `.env` is found before a deep tree is walked
  let level: Array<{ dir: string; rel: string }> = [{ dir: realDir, rel: '' }]
  for (let depth = 0; level.length > 0; depth++) {
    const next: Array<{ dir: string; rel: string }> = []
    for (const { dir, rel } of level) {
      let entries: Dirent[]
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (exhausted()) return true
        const path = rel === '' ? entry.name : `${rel}/${entry.name}`
        const isDir = entry.isDirectory()
        if (matches(path, isDir)) return true
        if (isDir) {
          if (depth + 1 > maxDepth) return true
          next.push({ dir: join(dir, entry.name), rel: path })
        }
      }
    }
    level = next
  }
  return false
}
