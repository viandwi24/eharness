/**
 * `mountFs`: a composite `FileSystem` that routes by longest virtual prefix to one `diskFs` per
 * mount (`/`, `/@dirs/<name>/`, `/.coder/tool-outputs/`).
 */
import type { FileMeta, FileSystem, GrepHit, MoveResult } from 'eharness/filesystem'
import type { Mount } from '../contracts.ts'
import { diskFs } from './disk-fs.ts'

const byPath = (a: { path: string }, b: { path: string }): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0

/**
 * Compose the mounts into one file system. The mount list is read on every call, so mounts added
 * at runtime are visible immediately.
 *
 * @param mounts Current mounts; virtual prefixes end in `/`.
 */
export function mountFs(mounts: () => Mount[]): FileSystem {
  const cache = new Map<string, FileSystem>()
  const innerFs = (mount: Mount): FileSystem => {
    const key = `${mount.virtual}\u0000${mount.real}\u0000${mount.readonly}`
    let inner = cache.get(key)
    if (!inner) {
      inner = diskFs(mount.real, { readonly: mount.readonly })
      cache.set(key, inner)
    }
    return inner
  }
  const sorted = (): Mount[] => [...mounts()].sort((a, b) => b.virtual.length - a.virtual.length)

  /** Mount owning `path` (longest prefix) and the path inside it. */
  const route = (path: string): { mount: Mount; inner: string } => {
    for (const mount of sorted()) {
      if (path === mount.virtual.slice(0, -1) || path.startsWith(mount.virtual)) {
        const inner = mount.virtual === '/' ? path : `/${path.slice(mount.virtual.length)}`
        return { mount, inner: inner === '' ? '/' : inner }
      }
    }
    throw new Error(`path outside the workspace: ${path}`)
  }

  const toVirtual = (mount: Mount, inner: string): string =>
    mount.virtual === '/' ? inner : mount.virtual.slice(0, -1) + inner

  /** True when a more specific mount than `mount` owns the virtual path. */
  const shadowed = (mount: Mount, virtual: string, all: Mount[]): boolean =>
    all.some(
      (other) =>
        other !== mount &&
        other.virtual.length > mount.virtual.length &&
        other.virtual.startsWith(mount.virtual) &&
        virtual.startsWith(other.virtual),
    )

  /** Mounts that can contain results for a prefix, with the prefix inside each. */
  const overlapping = (prefix: string): Array<{ mount: Mount; inner: string }> => {
    const all = mounts()
    const result: Array<{ mount: Mount; inner: string }> = []
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

  return {
    async read(path) {
      const { mount, inner } = route(path)
      const entry = await innerFs(mount).read(inner)
      return entry === null ? null : { ...entry, path }
    },

    async write(path, content, opts) {
      const { mount, inner } = route(path)
      return innerFs(mount).write(inner, content, opts)
    },

    async delete(path, opts) {
      const { mount, inner } = route(path)
      return innerFs(mount).delete(inner, opts)
    },

    async list(prefix = '/') {
      const all = mounts()
      const out: FileMeta[] = []
      for (const { mount, inner } of overlapping(prefix)) {
        for (const meta of await innerFs(mount).list(inner)) {
          const path = toVirtual(mount, meta.path)
          if (path.startsWith(prefix) && !shadowed(mount, path, all)) out.push({ ...meta, path })
        }
      }
      return out.sort(byPath)
    },

    async stat(path) {
      const { mount, inner } = route(path)
      const meta = (await innerFs(mount).stat?.(inner)) ?? null
      return meta === null ? null : { ...meta, path }
    },

    async grep(pattern, opts = {}) {
      const all = mounts()
      const prefix = opts.prefix ?? '/'
      const hits: GrepHit[] = []
      for (const { mount, inner } of overlapping(prefix)) {
        const found = await innerFs(mount).grep?.(pattern, { ...opts, prefix: inner })
        for (const hit of found ?? []) {
          const path = toVirtual(mount, hit.path)
          if (path.startsWith(prefix) && !shadowed(mount, path, all)) hits.push({ ...hit, path })
        }
      }
      hits.sort((a, b) => (a.path === b.path ? a.line - b.line : byPath(a, b)))
      return opts.maxHits === undefined ? hits : hits.slice(0, opts.maxHits)
    },

    async move(from, to, opts): Promise<MoveResult> {
      const source = route(from)
      const target = route(to)
      if (source.mount === target.mount) {
        const fs = innerFs(source.mount)
        if (fs.move) return fs.move(source.inner, target.inner, opts)
      }
      // Across mounts: not atomic. Create `to` only when absent, then delete `from`.
      const sourceFs = innerFs(source.mount)
      const targetFs = innerFs(target.mount)
      const entry = await sourceFs.read(source.inner)
      if (entry === null) return { ok: false, reason: 'missing' }
      if (opts?.ifVersion !== undefined && entry.version !== opts.ifVersion) {
        return { ok: false, reason: 'conflict', currentVersion: entry.version }
      }
      const written = await targetFs.write(target.inner, entry.content, { ifVersion: null })
      if (!written.ok) return { ok: false, reason: 'exists' }
      await sourceFs.delete(source.inner, { ifVersion: entry.version })
      return { ok: true }
    },
  }
}
