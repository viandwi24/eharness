/**
 * The workspace of the coder example: a virtual tree (`/` = project root, `/@dirs/<name>/` =
 * extra directories, `/.coder/tool-outputs/` = evicted tool outputs) over real directories.
 */
import { mkdir, realpath, stat } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import type { CoderConfig, Mount, Workspace } from '../contracts.ts'
import { createGuard, isInside } from './guard.ts'
import { mountFs } from './mount-fs.ts'

export { createDirAccessTool } from './dir-access.ts'
export { diskFs } from './disk-fs.ts'
export { mountFs } from './mount-fs.ts'

const TOOL_OUTPUTS_VIRTUAL = '/.coder/tool-outputs/'
// The tool-outputs mount is writable (`readonly: false`) because output eviction writes there.

/**
 * Build the workspace from the configuration. Creates `<projectDataDir>/tool-outputs`.
 *
 * @param config Resolved coder configuration (all paths real and absolute).
 */
export async function createWorkspace(config: CoderConfig): Promise<Workspace> {
  const toolOutputs = join(config.projectDataDir, 'tool-outputs')
  await mkdir(toolOutputs, { recursive: true })

  const mounts: Mount[] = [{ virtual: '/', real: config.root, readonly: false }]
  const names = new Set<string>()
  const addMount = (real: string): Mount => {
    const base = basename(real) || 'dir'
    let name = base
    for (let n = 2; names.has(name); n++) name = `${base}-${n}`
    names.add(name)
    const mount: Mount = { virtual: `/@dirs/${name}/`, real, readonly: false }
    mounts.push(mount)
    return mount
  }
  for (const dir of config.additionalDirectories) {
    if (!mounts.some((m) => m.real === dir)) addMount(dir)
  }
  mounts.push({ virtual: TOOL_OUTPUTS_VIRTUAL, real: toolOutputs, readonly: false })

  const guards = new Map<string, ReturnType<typeof createGuard>>()
  const guardOf = (real: string): ReturnType<typeof createGuard> => {
    let guard = guards.get(real)
    if (!guard) {
      guard = createGuard(real)
      guards.set(real, guard)
    }
    return guard
  }

  const workspace: Workspace = {
    root: config.root,
    fs: mountFs(() => mounts),
    mounts: () => mounts.map((m) => ({ ...m })),

    async toReal(virtualPath) {
      if (!virtualPath.startsWith('/')) return null
      const owner = [...mounts]
        .sort((a, b) => b.virtual.length - a.virtual.length)
        .find((m) => virtualPath === m.virtual.slice(0, -1) || virtualPath.startsWith(m.virtual))
      if (!owner) return null
      const inner =
        owner.virtual === '/' ? virtualPath : `/${virtualPath.slice(owner.virtual.length)}`
      try {
        return await guardOf(owner.real).resolve(inner === '' ? '/' : inner)
      } catch {
        return null
      }
    },

    toVirtual(realPath) {
      const owner = [...mounts]
        .sort((a, b) => b.real.length - a.real.length)
        .find((m) => isInside(m.real, realPath))
      if (!owner) return null
      const rel = relative(owner.real, realPath).split(sep).join('/')
      if (owner.virtual === '/') return `/${rel}`
      return rel === '' ? owner.virtual : owner.virtual + rel
    },

    async addDirectory(realPath) {
      const real = await realpath(realPath)
      if (!(await stat(real)).isDirectory()) throw new Error(`not a directory: ${real}`)
      const existing = mounts.find((m) => m.real === real)
      if (existing) return existing.virtual
      return addMount(real).virtual
    },
  }
  return workspace
}
