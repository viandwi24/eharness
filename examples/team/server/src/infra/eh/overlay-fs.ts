/**
 * An overlay `FileSystem` for rehearsals (docs/plans/P40-team-autonomous-operations.md, phase K):
 * every write, delete and move lands in the `scratch` file system, reads see the scratch first and
 * then `base` (the real library, read only here) unless the file was deleted in the overlay. With
 * `base: null` the run sees only the scratch (a rehearsal on sample data only). The base is never
 * written: it is only ever called through `read`, `readBytes`, `stat`, `list` and `grep`.
 *
 * Conditional writes (`ifVersion`) compare against what the overlay shows, so an agent that edits
 * a file it read from the library gets the same stale-edit protection as in a real run.
 */
import {
  type BinaryFile,
  compileGlob,
  type DeleteResult,
  type FileEntry,
  type FileMeta,
  type FileSystem,
  type GrepHit,
  type MoveResult,
  type WriteResult,
} from 'eharness/filesystem'

export interface OverlayFs extends FileSystem {
  /** The scratch file system: what the run wrote (and the sample files copied in). */
  readonly scratch: FileSystem
  /** Paths that exist in the base but were deleted in the overlay. */
  deletedPaths(): string[]
  stat(path: string): Promise<FileMeta | null>
}

const byPath = (a: { path: string }, b: { path: string }): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0

async function metaOf(fs: FileSystem, path: string): Promise<FileMeta | null> {
  if (fs.stat !== undefined) return fs.stat(path)
  try {
    return await fs.read(path)
  } catch {
    // a binary file: `read` throws, the file exists
    const bytes = await fs.readBytes?.(path)
    return bytes?.meta ?? null
  }
}

async function bytesOf(fs: FileSystem, path: string): Promise<BinaryFile | null> {
  if (fs.readBytes !== undefined) return fs.readBytes(path)
  const entry = await fs.read(path)
  if (entry === null) return null
  return { bytes: new TextEncoder().encode(entry.content), meta: entry }
}

export function overlayFs(options: { base: FileSystem | null; scratch: FileSystem }): OverlayFs {
  const { base, scratch } = options
  const deleted = new Set<string>()
  const visibleInBase = (path: string): boolean => base !== null && !deleted.has(path)

  const stat = async (path: string): Promise<FileMeta | null> => {
    const mine = await metaOf(scratch, path)
    if (mine !== null) return mine
    return base !== null && !deleted.has(path) ? metaOf(base, path) : null
  }

  /** The write conditions of `FileSystem.write`, checked against what the overlay shows. */
  async function precondition(
    path: string,
    ifVersion: string | null | undefined,
  ): Promise<Extract<WriteResult, { ok: false }> | undefined> {
    if (ifVersion === undefined) return undefined
    const cur = await stat(path)
    if (ifVersion === null && cur !== null) {
      return { ok: false, reason: 'exists', currentVersion: cur.version }
    }
    if (typeof ifVersion === 'string' && cur?.version !== ifVersion) {
      return cur === null
        ? { ok: false, reason: 'conflict' }
        : { ok: false, reason: 'conflict', currentVersion: cur.version }
    }
    return undefined
  }

  const list = async (prefix = '/'): Promise<FileMeta[]> => {
    const mine = await scratch.list(prefix)
    const own = new Set(mine.map((m) => m.path))
    const theirs =
      base === null
        ? []
        : (await base.list(prefix)).filter((m) => !deleted.has(m.path) && !own.has(m.path))
    return [...mine, ...theirs].sort(byPath)
  }

  const self: OverlayFs = {
    scratch,
    deletedPaths: () => [...deleted].sort(),

    async read(path): Promise<FileEntry | null> {
      const mine = await scratch.read(path)
      if (mine !== null) return mine
      return visibleInBase(path) ? ((await base?.read(path)) ?? null) : null
    },

    async readBytes(path): Promise<BinaryFile | null> {
      const mine = await bytesOf(scratch, path)
      if (mine !== null) return mine
      return base !== null && visibleInBase(path) ? bytesOf(base, path) : null
    },

    async write(path, content, opts = {}): Promise<WriteResult> {
      const refused = await precondition(path, opts.ifVersion)
      if (refused !== undefined) return refused
      const result = await scratch.write(path, content, {
        ...(opts.author === undefined ? {} : { author: opts.author }),
      })
      if (result.ok) deleted.delete(path)
      return result
    },

    async writeBytes(path, bytes, opts = {}): Promise<WriteResult> {
      const refused = await precondition(path, opts.ifVersion)
      if (refused !== undefined) return refused
      const write = scratch.writeBytes
      if (write === undefined) throw new Error('the rehearsal scratch cannot store binary files')
      const result = await write.call(scratch, path, bytes, {
        ...(opts.mediaType === undefined ? {} : { mediaType: opts.mediaType }),
        ...(opts.author === undefined ? {} : { author: opts.author }),
      })
      if (result.ok) deleted.delete(path)
      return result
    },

    async delete(path, opts = {}): Promise<DeleteResult> {
      const cur = await stat(path)
      if (cur === null) return { ok: false, reason: 'missing' }
      if (opts.ifVersion !== undefined && cur.version !== opts.ifVersion) {
        return { ok: false, reason: 'conflict', currentVersion: cur.version }
      }
      if ((await metaOf(scratch, path)) !== null) await scratch.delete(path)
      if (base !== null && (await metaOf(base, path)) !== null) deleted.add(path)
      return { ok: true }
    },

    list,
    stat,

    async grep(pattern, opts = {}): Promise<GrepHit[]> {
      const maxHits = opts.maxHits ?? Number.POSITIVE_INFINITY
      if (maxHits <= 0) return []
      const prefix = opts.prefix ?? '/'
      const mine = (await scratch.grep?.(pattern, { prefix, maxHits })) ?? []
      let theirs: GrepHit[] = []
      if (base !== null && base.grep !== undefined) {
        const own = new Set((await scratch.list(prefix)).map((m) => m.path))
        // files the overlay replaced or deleted must not show their old lines: ask for a little more
        const slack = own.size + deleted.size
        theirs = (
          await base.grep(pattern, {
            prefix,
            ...(Number.isFinite(maxHits) ? { maxHits: maxHits + slack } : {}),
          })
        ).filter((h) => !own.has(h.path) && !deleted.has(h.path))
      }
      return [...mine, ...theirs]
        .sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1))
        .slice(0, Number.isFinite(maxHits) ? maxHits : undefined)
    },

    async glob(pattern, opts): Promise<FileMeta[]> {
      const compiled = compileGlob(pattern)
      if (!compiled.ok) return []
      const out: FileMeta[] = []
      for (const meta of await list(opts.prefix)) {
        if (!compiled.test(meta.path.slice(opts.prefix.length))) continue
        out.push(meta)
        if (out.length >= opts.limit) break
      }
      return out
    },

    async move(from, to, opts = {}): Promise<MoveResult> {
      const cur = await stat(from)
      if (cur === null) return { ok: false, reason: 'missing' }
      if (opts.ifVersion !== undefined && cur.version !== opts.ifVersion) {
        return { ok: false, reason: 'conflict', currentVersion: cur.version }
      }
      if ((await stat(to)) !== null) return { ok: false, reason: 'exists' }
      const file = await self.readBytes?.(from)
      if (file === null || file === undefined) return { ok: false, reason: 'missing' }
      const written = await self.writeBytes?.(to, file.bytes, {
        ...(file.mediaType === undefined ? {} : { mediaType: file.mediaType }),
      })
      if (written === undefined || !written.ok) return { ok: false, reason: 'exists' }
      await self.delete(from)
      return { ok: true }
    },
  }
  return self
}

/**
 * A view of `base` that refuses every change: the file system of a rehearsal session that is not
 * running any more (its overlay is gone). The model of such a session can still read, but it can
 * never write to the real library.
 */
export function readOnlyFs(base: FileSystem): FileSystem {
  const refuse = (): never => {
    throw new Error('this rehearsal has ended: its files are read-only')
  }
  return {
    read: (path) => base.read(path),
    list: (prefix) => base.list(prefix),
    ...(base.stat === undefined
      ? {}
      : { stat: (path: string) => base.stat?.(path) ?? Promise.resolve(null) }),
    ...(base.grep === undefined
      ? {}
      : {
          grep: (...args: Parameters<NonNullable<FileSystem['grep']>>) =>
            base.grep?.(...args) ?? Promise.resolve([]),
        }),
    ...(base.glob === undefined
      ? {}
      : {
          glob: (...args: Parameters<NonNullable<FileSystem['glob']>>) =>
            base.glob?.(...args) ?? Promise.resolve([]),
        }),
    ...(base.readBytes === undefined
      ? {}
      : { readBytes: (path: string) => base.readBytes?.(path) ?? Promise.resolve(null) }),
    write: refuse,
    delete: refuse,
    move: refuse,
    writeBytes: refuse,
  }
}
