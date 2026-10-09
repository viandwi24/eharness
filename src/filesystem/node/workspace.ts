/**
 * `nodeWorkspace`: a virtual tree over real directories (spec 08 §10): `/` = the project root,
 * `/@dirs/<name>/` = extra directories, `/.eharness/tool-outputs/` = an optional real directory
 * for evicted tool outputs.
 */
import { mkdir, realpath, stat } from 'node:fs/promises'
import { basename, relative, sep } from 'node:path'
import type { FileSystem } from '../types.ts'
import { type DiskFsOptions, diskFs } from './disk-fs.ts'
import { createGuard, isInside } from './guard.ts'
import { mountFs } from './mount-fs.ts'

/** One mount of a {@link NodeWorkspace}. */
export interface WorkspaceMount {
  /** Virtual prefix (`/`, `/@dirs/lib/`, `/.eharness/tool-outputs/`). */
  virtual: string
  /** Real absolute directory. */
  real: string
  readonly: boolean
}

/** Options of {@link nodeWorkspace}. */
export interface NodeWorkspaceOptions {
  /** Real project directory, mounted at `/`. */
  root: string
  /** Extra real directories, mounted at `/@dirs/<basename>/` (`-2`, `-3`… on a clash). */
  extraDirs?: string[]
  /**
   * Real directory (created if missing) mounted at `/.eharness/tool-outputs/`, writable. Pass it
   * to keep evicted tool outputs out of the project; the default `filesystem()` option
   * `toolOutputs.dir` points there. Without it, no such mount exists.
   */
  toolOutputsDir?: string
  /** Options for every `diskFs` of the workspace (ignore rules, size limit, grep, readonly). */
  diskFs?: DiskFsOptions
}

/** The result of {@link nodeWorkspace}. */
export interface NodeWorkspace {
  /** Real absolute project root. */
  readonly root: string
  /** The composed file system: pass it to `filesystem({ fs })`. */
  readonly fs: FileSystem
  /** Snapshot of the current mounts. */
  mounts(): WorkspaceMount[]
  /** Mount another real directory; returns its virtual prefix (idempotent per directory). */
  addDirectory(real: string): Promise<string>
  /** Real path of a virtual path, `null` when outside every mount or escaping through a link. */
  toReal(virtual: string): Promise<string | null>
  /** Virtual path of a real path, `null` when it lies in no mount. */
  toVirtual(real: string): string | null
}

/** `DEFAULT_TOOL_OUTPUTS_DIR` of the plugin plus a trailing slash. */
const TOOL_OUTPUTS_VIRTUAL = '/.eharness/tool-outputs/'

/**
 * Build a workspace of real directories.
 *
 * @example
 * ```ts
 * const ws = await nodeWorkspace({ root: process.cwd(), extraDirs: ['/home/me/lib'] })
 * const agent = defineHarnessAgent({ model, plugins: [filesystem({ fs: ws.fs })] })
 * await ws.addDirectory('/home/me/other') // visible immediately, no restart
 * ```
 * @throws {Error} `not a directory: <path>` when a directory is not one; filesystem errors for
 *   directories that do not exist.
 * @see docs/specs/08-filesystem-plugin.md#10-node-workspace
 */
export async function nodeWorkspace(options: NodeWorkspaceOptions): Promise<NodeWorkspace> {
  const root = await realpath(options.root)
  const mounts: WorkspaceMount[] = [{ virtual: '/', real: root, readonly: false }]
  const names = new Set<string>()
  const addMount = (real: string): WorkspaceMount => {
    const base = basename(real) || 'dir'
    let name = base
    for (let n = 2; names.has(name); n++) name = `${base}-${n}`
    names.add(name)
    const mount: WorkspaceMount = { virtual: `/@dirs/${name}/`, real, readonly: false }
    mounts.push(mount)
    return mount
  }
  for (const dir of options.extraDirs ?? []) {
    const real = await realpath(dir)
    if (!mounts.some((m) => m.real === real)) addMount(real)
  }
  if (options.toolOutputsDir !== undefined) {
    await mkdir(options.toolOutputsDir, { recursive: true })
    mounts.push({
      virtual: TOOL_OUTPUTS_VIRTUAL,
      real: await realpath(options.toolOutputsDir),
      readonly: false,
    })
  }

  const disks = new Map<string, FileSystem>()
  const diskOf = (mount: WorkspaceMount): FileSystem => {
    const key = `${mount.real}\u0000${mount.readonly}`
    let fs = disks.get(key)
    if (!fs) {
      fs = diskFs(mount.real, {
        ...options.diskFs,
        readonly: mount.readonly || options.diskFs?.readonly,
      })
      disks.set(key, fs)
    }
    return fs
  }

  const owner = (virtual: string): WorkspaceMount | undefined =>
    [...mounts]
      .sort((a, b) => b.virtual.length - a.virtual.length)
      .find((m) => virtual === m.virtual.slice(0, -1) || virtual.startsWith(m.virtual))

  return {
    root,
    fs: mountFs(() =>
      mounts.map((m) => ({ virtual: m.virtual, fs: diskOf(m), readonly: m.readonly })),
    ),
    mounts: () => mounts.map((m) => ({ ...m })),

    async toReal(virtual) {
      if (!virtual.startsWith('/')) return null
      const mount = owner(virtual)
      if (!mount) return null
      const inner = mount.virtual === '/' ? virtual : `/${virtual.slice(mount.virtual.length)}`
      try {
        return await createGuard(mount.real).resolve(inner === '' ? '/' : inner)
      } catch {
        return null
      }
    },

    toVirtual(real) {
      const mount = [...mounts]
        .sort((a, b) => b.real.length - a.real.length)
        .find((m) => isInside(m.real, real))
      if (!mount) return null
      const rel = relative(mount.real, real).split(sep).join('/')
      if (mount.virtual === '/') return `/${rel}`
      return rel === '' ? mount.virtual : mount.virtual + rel
    },

    async addDirectory(real) {
      const resolved = await realpath(real)
      if (!(await stat(resolved)).isDirectory()) throw new Error(`not a directory: ${resolved}`)
      const existing = mounts.find((m) => m.real === resolved)
      if (existing) return existing.virtual
      return addMount(resolved).virtual
    },
  }
}
