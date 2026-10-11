/**
 * Path containment: a virtual path is joined to a real root, resolved through symlinks and
 * rejected when the real result is not inside the real root.
 */
import { constants, open, realpath } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

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
  /** Real path of a normalized virtual path; throws `path outside the workspace: <path>`. */
  resolve(virtualPath: string): Promise<string>
  /**
   * Read a path returned by `resolve` without following a symlink on the final component
   * (`O_NOFOLLOW` where the platform has it) and re-validate containment after the open, so a
   * symlink swapped in between `resolve` and the read cannot escape the root.
   */
  readContained(real: string): Promise<Uint8Array>
  /** Throws `path outside the workspace` unless the real parent of `real` is inside the root. */
  assertParentInside(real: string): Promise<void>
}

/**
 * Containment guard for one root.
 *
 * @param root Real absolute directory (resolved once, lazily).
 */
export function createGuard(root: string): Guard {
  let realRoot: Promise<string> | undefined
  const getRoot = (): Promise<string> => {
    realRoot ??= realpath(root)
    return realRoot
  }
  const escapes = (p: string): Error => new Error(`path outside the workspace: ${p}`)
  return {
    async readContained(real: string): Promise<Uint8Array> {
      const base = await getRoot()
      const handle = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const after = await realpath(real)
        if (!isInside(base, after)) throw escapes(real)
        const info = await handle.stat()
        if (!info.isFile()) throw escapes(real)
        return new Uint8Array(await handle.readFile())
      } finally {
        await handle.close()
      }
    },
    async assertParentInside(real: string): Promise<void> {
      const base = await getRoot()
      if (!isInside(base, await realpath(dirname(real)))) throw escapes(real)
    },
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
