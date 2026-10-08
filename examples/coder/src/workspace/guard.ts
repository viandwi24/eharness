/**
 * Path containment and ignore rules of the workspace (docs/plans/P30-coder-example.md §5).
 *
 * A virtual path is joined to a real root, resolved through symlinks and rejected when the real
 * result is not inside the real root. Ignore rules (`.git/`, `node_modules/`, the root
 * `.gitignore`) only hide paths from listings; explicit reads still work.
 */
import { readFile, realpath } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import ignore from 'ignore'

/** True when `real` is `root` or lies inside it (both must be real, absolute paths). */
export function isInside(root: string, real: string): boolean {
  if (real === root) return true
  const prefix = root.endsWith(sep) ? root : root + sep
  return real.startsWith(prefix)
}

/**
 * `realpath` that also works for paths that do not exist yet: the real path of the nearest
 * existing parent plus the remaining segments.
 */
export async function realpathLoose(path: string): Promise<string> {
  const rest: string[] = []
  let current = resolve(path)
  for (;;) {
    try {
      const real = await realpath(current)
      return rest.length === 0 ? real : join(real, ...rest.reverse())
    } catch (error) {
      const parent = dirname(current)
      if (parent === current) throw error
      rest.push(current.slice(parent.length).replace(/^[\\/]+/, ''))
      current = parent
    }
  }
}

/** Resolves virtual paths below one real root and rejects every escape. */
export interface Guard {
  /** The real root. */
  readonly root: string
  /** Real path of a normalized virtual path; throws `path outside the workspace: <path>`. */
  resolve(virtualPath: string): Promise<string>
}

/**
 * Containment guard for one real root.
 *
 * @param root Real absolute directory (resolved once, lazily).
 */
export function createGuard(root: string): Guard {
  let realRoot: Promise<string> | undefined
  const getRoot = (): Promise<string> => {
    realRoot ??= realpath(root)
    return realRoot
  }
  return {
    root,
    async resolve(virtualPath: string): Promise<string> {
      const outside = (): Error => new Error(`path outside the workspace: ${virtualPath}`)
      if (!virtualPath.startsWith('/') || virtualPath.includes('\u0000')) throw outside()
      const segments = virtualPath.split('/').filter((s) => s !== '' && s !== '.')
      if (segments.includes('..')) throw outside()
      const base = await getRoot()
      const real = await realpathLoose(join(base, ...segments))
      if (!isInside(base, real)) throw outside()
      return real
    },
  }
}

/** Decides which paths are hidden from listings. */
export interface IgnoreRules {
  /** `relPath` is relative to the root with `/` separators; `isDir` adds the directory form. */
  isHidden(relPath: string, isDir: boolean): boolean
}

const ALWAYS_HIDDEN = new Set(['.git', 'node_modules'])

/**
 * Ignore rules: `.git/` and `node_modules/` always, plus the root `.gitignore` of `root`
 * (read once, when the rules are created). Nested `.gitignore` files are not applied.
 *
 * @param root Real absolute directory.
 */
export async function loadIgnoreRules(root: string): Promise<IgnoreRules> {
  const matcher = ignore()
  try {
    matcher.add(await readFile(join(root, '.gitignore'), 'utf8'))
  } catch {
    // no .gitignore
  }
  return {
    isHidden(relPath, isDir) {
      const rel = relPath.replace(/^\/+/, '').replace(/\/+$/, '')
      if (rel === '' || rel.startsWith('../')) return false
      if (rel.split('/').some((segment) => ALWAYS_HIDDEN.has(segment))) return true
      return matcher.ignores(isDir ? `${rel}/` : rel)
    },
  }
}
