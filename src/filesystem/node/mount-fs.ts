/**
 * `mountFs`: a composite `FileSystem` that routes by longest virtual prefix to one `FileSystem`
 * per mount (spec 08 §9).
 */
import { compileGlob } from '../glob.ts'
import type { FileMeta, FileSystem, GrepHit, MoveResult } from '../types.ts'

/** One mount of {@link mountFs}. */
export interface FsMount {
  /** Virtual prefix: starts and ends with `/` (`'/'` or `'/@dirs/lib/'`). */
  virtual: string
  /** The file system serving everything below `virtual`; its `/` is the mount point. */
  fs: FileSystem
  /** `write`, `delete` and `move` into this mount throw `read-only directory: <path>`. */
  readonly?: boolean
}

const byPath = (a: { path: string }, b: { path: string }): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0

/**
 * Compose mounts into one file system. The mount list is read on every call, so mounts added at
 * runtime are visible immediately. A path outside every mount throws `path outside the
 * workspace: <path>`. Listings and searches are merged and sorted; a file of a less specific
 * mount that sits below a more specific mount point is shadowed (not listed, not readable).
 *
 * `move` inside one mount is that mount's `move`. A move **across mounts is not atomic**: it
 * creates `to` (only if absent), then deletes `from`; a crash in between leaves both.
 *
 * @param mounts Current mounts; virtual prefixes end in `/`.
 * @throws {TypeError} when a mount's `virtual` does not start and end with `/`.
 * @see docs/specs/08-filesystem-plugin.md#9-mounts
 */
export function mountFs(mounts: () => FsMount[]): FileSystem {
  const current = (): FsMount[] => {
    const all = mounts()
    for (const mount of all) {
      if (!mount.virtual.startsWith('/') || !mount.virtual.endsWith('/')) {
        throw new TypeError(`mountFs: virtual prefix must start and end with "/": ${mount.virtual}`)
      }
    }
    return all
  }

  /** Mount owning `path` (longest prefix) and the path inside it. */
  const route = (path: string): { mount: FsMount; inner: string } => {
    const all = [...current()].sort((a, b) => b.virtual.length - a.virtual.length)
    for (const mount of all) {
      if (path === mount.virtual.slice(0, -1) || path.startsWith(mount.virtual)) {
        const inner = mount.virtual === '/' ? path : `/${path.slice(mount.virtual.length)}`
        return { mount, inner: inner === '' ? '/' : inner }
      }
    }
    throw new Error(`path outside the workspace: ${path}`)
  }

  const writable = (mount: FsMount, path: string): void => {
    if (mount.readonly) throw new Error(`read-only directory: ${path}`)
  }

  const toVirtual = (mount: FsMount, inner: string): string =>
    mount.virtual === '/' ? inner : mount.virtual.slice(0, -1) + inner

  /** True when a more specific mount than `mount` owns the virtual path. */
  const shadowed = (mount: FsMount, virtual: string, all: FsMount[]): boolean =>
    all.some(
      (other) =>
        other !== mount &&
        other.virtual.length > mount.virtual.length &&
        other.virtual.startsWith(mount.virtual) &&
        virtual.startsWith(other.virtual),
    )

  /** Mounts that can contain results for a prefix, with the prefix inside each. */
  const overlapping = (
    prefix: string,
    all: FsMount[],
  ): Array<{ mount: FsMount; inner: string }> => {
    const result: Array<{ mount: FsMount; inner: string }> = []
    for (const mount of all) {
      if (prefix.startsWith(mount.virtual) || `${prefix}/` === mount.virtual) {
        const inner = mount.virtual === '/' ? prefix : `/${prefix.slice(mount.virtual.length)}`
        result.push({ mount, inner })
      } else if (mount.virtual.startsWith(prefix)) {
        result.push({ mount, inner: '/' })
      }
    }
    return result
  }

  const fs: FileSystem = {
    async read(path) {
      const { mount, inner } = route(path)
      const entry = await mount.fs.read(inner)
      return entry === null ? null : { ...entry, path }
    },

    async write(path, content, opts) {
      const { mount, inner } = route(path)
      writable(mount, path)
      return mount.fs.write(inner, content, opts)
    },

    async readBytes(path) {
      const { mount, inner } = route(path)
      if (mount.fs.readBytes === undefined)
        throw new Error(`binary files are not supported: ${path}`)
      const file = await mount.fs.readBytes(inner)
      return file === null ? null : { ...file, meta: { ...file.meta, path } }
    },

    async writeBytes(path, bytes, opts) {
      const { mount, inner } = route(path)
      writable(mount, path)
      if (mount.fs.writeBytes === undefined)
        throw new Error(`binary files are not supported: ${path}`)
      return mount.fs.writeBytes(inner, bytes, opts)
    },

    async delete(path, opts) {
      const { mount, inner } = route(path)
      writable(mount, path)
      return mount.fs.delete(inner, opts)
    },

    async list(prefix = '/') {
      const all = current()
      const out: FileMeta[] = []
      for (const { mount, inner } of overlapping(prefix, all)) {
        for (const meta of await mount.fs.list(inner)) {
          const path = toVirtual(mount, meta.path)
          if (path.startsWith(prefix) && !shadowed(mount, path, all)) out.push({ ...meta, path })
        }
      }
      return out.sort(byPath)
    },

    async stat(path) {
      const { mount, inner } = route(path)
      const meta = mount.fs.stat ? await mount.fs.stat(inner) : await statByList(mount.fs, inner)
      return meta === null ? null : { ...meta, path }
    },

    async grep(pattern, opts = {}) {
      const all = current()
      const prefix = opts.prefix ?? '/'
      const hits: GrepHit[] = []
      for (const { mount, inner } of overlapping(prefix, all)) {
        const found = mount.fs.grep
          ? await mount.fs.grep(pattern, { ...opts, prefix: inner })
          : await grepByRead(mount.fs, pattern, inner)
        for (const hit of found) {
          const path = toVirtual(mount, hit.path)
          if (path.startsWith(prefix) && !shadowed(mount, path, all)) hits.push({ ...hit, path })
        }
      }
      hits.sort((a, b) => (a.path === b.path ? a.line - b.line : byPath(a, b)))
      return opts.maxHits === undefined ? hits : hits.slice(0, opts.maxHits)
    },

    async glob(pattern, opts) {
      const compiled = compileGlob(pattern)
      if (!compiled.ok) return []
      const found = (await fs.list(opts.prefix)).filter((m) =>
        compiled.test(m.path.slice(opts.prefix.length)),
      )
      return found.slice(0, opts.limit)
    },

    async move(from, to, opts): Promise<MoveResult> {
      const source = route(from)
      const target = route(to)
      writable(source.mount, from)
      writable(target.mount, to)
      if (source.mount === target.mount && source.mount.fs.move) {
        return source.mount.fs.move(source.inner, target.inner, opts)
      }
      // Across mounts (or an adapter without `move`): not atomic. Create `to` only when absent,
      // then delete `from`.
      const entry = await source.mount.fs.read(source.inner)
      if (entry === null) return { ok: false, reason: 'missing' }
      if (opts?.ifVersion !== undefined && entry.version !== opts.ifVersion) {
        return { ok: false, reason: 'conflict', currentVersion: entry.version }
      }
      const written = await target.mount.fs.write(target.inner, entry.content, { ifVersion: null })
      if (!written.ok) return { ok: false, reason: 'exists' }
      await source.mount.fs.delete(source.inner, { ifVersion: entry.version })
      return { ok: true }
    },
  }
  return fs
}

async function statByList(fs: FileSystem, path: string): Promise<FileMeta | null> {
  return (await fs.list(path)).find((m) => m.path === path) ?? null
}

async function grepByRead(fs: FileSystem, pattern: RegExp, prefix: string): Promise<GrepHit[]> {
  const re = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''))
  const hits: GrepHit[] = []
  for (const meta of await fs.list(prefix)) {
    if (meta.binary) continue
    const file = await fs.read(meta.path).catch(() => null)
    if (!file) continue
    file.content.split('\n').forEach((raw, i) => {
      const text = raw.replace(/\r$/, '')
      if (re.test(text)) hits.push({ path: meta.path, line: i + 1, text })
    })
  }
  return hits
}
