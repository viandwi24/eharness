/**
 * `diskFs(root)`: the eharness `FileSystem` contract over `node:fs/promises`.
 *
 * Containment is enforced on every call (see `guard.ts`). Conditional writes are
 * compare-and-set under a per-path in-process mutex; writes go through a temp file and `rename`.
 */
import { spawn } from 'node:child_process'
import type { BigIntStats, Dirent } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  contentVersion,
  type DeleteResult,
  type FileEntry,
  type FileMeta,
  type FileSystem,
  type GrepHit,
  type MoveResult,
  type WriteResult,
} from 'eharness/filesystem'
import { keyedMutex } from '../../../shared/mutex.ts'
import { createGuard, isInside, loadIgnoreRules } from './guard.ts'

const MAX_BYTES = 2 * 1024 * 1024
const strictUtf8 = new TextDecoder('utf-8', { fatal: true })
const lenientUtf8 = new TextDecoder('utf-8')

const byPath = (a: { path: string }, b: { path: string }): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0

const isMissing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * A `FileSystem` over a real directory.
 *
 * @param root Real absolute directory; it is the virtual `/`.
 * @param opts `readonly: true` makes write, delete and move throw `read-only directory: <path>`.
 */
export function diskFs(root: string, opts: { readonly?: boolean } = {}): FileSystem {
  const guard = createGuard(root)
  const exclusive = keyedMutex()
  const metaCache = new Map<
    string,
    { mtimeNs: bigint; ino: bigint; size: number; version: string }
  >()

  const checkWritable = (path: string): void => {
    if (opts.readonly) throw new Error(`read-only directory: ${path}`)
  }

  /** Version of the current file content, `null` when missing. Lenient: never throws on binary. */
  const currentVersion = async (real: string): Promise<string | null> => {
    try {
      const info = await stat(real)
      if (!info.isFile()) return null
      const bytes = await readFile(real)
      return await contentVersion(lenientUtf8.decode(bytes))
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  }

  const atomicWrite = async (real: string, content: string): Promise<void> => {
    await mkdir(dirname(real), { recursive: true })
    const temp = join(dirname(real), `.${basename(real)}.${crypto.randomUUID().slice(0, 8)}.tmp`)
    try {
      await writeFile(temp, content, 'utf8')
      await rename(temp, real)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {})
      throw error
    }
  }

  /** Metadata of a regular text file, `null` for anything else (cached by mtime/inode/size). */
  const metaOf = async (real: string, path: string): Promise<FileMeta | null> => {
    let info: BigIntStats
    try {
      info = await stat(real, { bigint: true })
    } catch {
      return null
    }
    if (!info.isFile() || info.size > BigInt(MAX_BYTES)) return null
    const cached = metaCache.get(real)
    const updatedAt = Number(info.mtimeMs)
    if (cached && cached.mtimeNs === info.mtimeNs && cached.ino === info.ino) {
      return { path, version: cached.version, size: cached.size, updatedAt }
    }
    try {
      const bytes = await readFile(real)
      const version = await contentVersion(strictUtf8.decode(bytes))
      metaCache.set(real, {
        mtimeNs: info.mtimeNs,
        ino: info.ino,
        size: bytes.length,
        version,
      })
      return { path, version, size: bytes.length, updatedAt }
    } catch {
      return null // binary or vanished
    }
  }

  /** Visible regular files below a virtual directory, as virtual paths with their real paths. */
  const walk = async (virtualDir: string): Promise<Array<{ path: string; real: string }>> => {
    const baseReal = await guard.resolve(virtualDir)
    const realRoot = await guard.resolve('/')
    const ignored = await loadIgnoreRules(realRoot)
    const found: Array<{ path: string; real: string }> = []
    const visit = async (real: string, virtual: string): Promise<void> => {
      let entries: Dirent[]
      try {
        entries = await readdir(real, { withFileTypes: true })
      } catch {
        return
      }
      const relDir = virtual === '/' ? '' : virtual.slice(1)
      for (const entry of entries) {
        const child = join(real, entry.name)
        const childVirtual = virtual === '/' ? `/${entry.name}` : `${virtual}/${entry.name}`
        const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`
        if (entry.isDirectory()) {
          if (!ignored.isHidden(rel, true)) await visit(child, childVirtual)
        } else if (entry.isFile()) {
          if (!ignored.isHidden(rel, false)) found.push({ path: childVirtual, real: child })
        } else if (entry.isSymbolicLink()) {
          if (ignored.isHidden(rel, false)) continue
          try {
            const target = await guard.resolve(childVirtual)
            if ((await stat(target)).isFile()) found.push({ path: childVirtual, real: target })
          } catch {
            // dangling or escaping symlink: not listed
          }
        }
      }
    }
    await visit(baseReal, virtualDir)
    return found
  }

  const list = async (prefix = '/'): Promise<FileMeta[]> => {
    const dir = prefix.endsWith('/') ? prefix : prefix.slice(0, prefix.lastIndexOf('/') + 1) || '/'
    const files = (await walk(dir.length > 1 ? dir.slice(0, -1) : '/')).filter((f) =>
      f.path.startsWith(prefix),
    )
    const metas: FileMeta[] = []
    for (let i = 0; i < files.length; i += 64) {
      const chunk = await Promise.all(files.slice(i, i + 64).map((f) => metaOf(f.real, f.path)))
      for (const meta of chunk) if (meta) metas.push(meta)
    }
    return metas.sort(byPath)
  }

  const grepJs = async (pattern: RegExp, prefix: string, maxHits: number): Promise<GrepHit[]> => {
    const re = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''))
    const hits: GrepHit[] = []
    for (const meta of await list(prefix)) {
      const file = await fs.read(meta.path).catch(() => null)
      if (!file) continue
      const lines = file.content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const text = (lines[i] ?? '').replace(/\r$/, '')
        if (re.test(text)) hits.push({ path: meta.path, line: i + 1, text })
        if (hits.length >= maxHits) return hits
      }
    }
    return hits
  }

  const grepRg = async (
    rg: string,
    pattern: RegExp,
    prefix: string,
    maxHits: number,
  ): Promise<GrepHit[] | null> => {
    const dir = prefix.endsWith('/') ? prefix : prefix.slice(0, prefix.lastIndexOf('/') + 1) || '/'
    const realRoot = await guard.resolve('/')
    const realDir = await guard.resolve(dir.length > 1 ? dir.slice(0, -1) : '/')
    const rules = await loadIgnoreRules(realRoot)
    const args = [
      '--json',
      '--hidden',
      '--no-require-git',
      '--no-messages',
      '--max-filesize',
      '2M',
      '--glob',
      '!.git',
      '--glob',
      '!node_modules',
    ]
    if (pattern.flags.includes('i')) args.push('--ignore-case')
    args.push('-e', pattern.source, '--', realDir)
    const output = await new Promise<{ code: number | null; stdout: string }>((done, fail) => {
      const child = spawn(rg, args, { cwd: realRoot, stdio: ['ignore', 'pipe', 'ignore'] })
      const chunks: Buffer[] = []
      child.stdout.on('data', (c: Buffer) => chunks.push(c))
      child.on('error', fail)
      child.on('close', (code) => done({ code, stdout: Buffer.concat(chunks).toString('utf8') }))
    })
    if (output.code !== 0 && output.code !== 1) return null // bad regex for rg etc.
    const hits: GrepHit[] = []
    for (const line of output.stdout.split('\n')) {
      if (!line.startsWith('{')) continue
      let event: {
        type: string
        data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number }
      }
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (event.type !== 'match' || !event.data) continue
      const file = event.data.path?.text
      const text = event.data.lines?.text
      if (file === undefined || text === undefined || event.data.line_number === undefined) continue
      if (!isInside(realRoot, file)) continue
      const rel = file.slice(realRoot.length).replace(/^[\\/]+/, '')
      if (rules.isHidden(rel, false)) continue
      const path = `/${rel.split('\\').join('/')}`
      if (!path.startsWith(prefix)) continue
      hits.push({ path, line: event.data.line_number, text: text.replace(/\r?\n$/, '') })
    }
    hits.sort((a, b) => (a.path === b.path ? a.line - b.line : byPath(a, b)))
    return hits.slice(0, maxHits)
  }

  const fs: FileSystem = {
    async read(path): Promise<FileEntry | null> {
      const real = await guard.resolve(path)
      let info: Awaited<ReturnType<typeof stat>>
      try {
        info = await stat(real)
      } catch (error) {
        if (isMissing(error)) return null
        throw error
      }
      if (info.isDirectory()) return null
      if (!info.isFile() || info.size > MAX_BYTES)
        throw new Error(`binary or too large file: ${path}`)
      const bytes = await readFile(real)
      let content: string
      try {
        content = strictUtf8.decode(bytes)
      } catch {
        throw new Error(`binary or too large file: ${path}`)
      }
      return {
        path,
        content,
        version: await contentVersion(content),
        size: bytes.length,
        updatedAt: info.mtimeMs,
      }
    },

    async write(path, content, options = {}): Promise<WriteResult> {
      checkWritable(path)
      const real = await guard.resolve(path)
      return exclusive(real, async () => {
        const current = await currentVersion(real)
        if (options.ifVersion === null && current !== null) {
          return { ok: false, reason: 'exists', currentVersion: current }
        }
        if (typeof options.ifVersion === 'string' && current !== options.ifVersion) {
          return current === null
            ? { ok: false, reason: 'conflict' }
            : { ok: false, reason: 'conflict', currentVersion: current }
        }
        await atomicWrite(real, content)
        return { ok: true, version: await contentVersion(content) }
      })
    },

    async delete(path, options = {}): Promise<DeleteResult> {
      checkWritable(path)
      const real = await guard.resolve(path)
      return exclusive(real, async () => {
        const current = await currentVersion(real)
        if (current === null) return { ok: false, reason: 'missing' }
        if (options.ifVersion !== undefined && current !== options.ifVersion) {
          return { ok: false, reason: 'conflict', currentVersion: current }
        }
        await unlink(real)
        metaCache.delete(real)
        return { ok: true }
      })
    },

    list,

    async stat(path): Promise<FileMeta | null> {
      return metaOf(await guard.resolve(path), path)
    },

    async grep(pattern, options = {}): Promise<GrepHit[]> {
      const prefix = options.prefix ?? '/'
      const maxHits = options.maxHits ?? Number.POSITIVE_INFINITY
      const rg = typeof Bun !== 'undefined' ? Bun.which('rg') : null
      if (rg) {
        const hits = await grepRg(rg, pattern, prefix, maxHits).catch(() => null)
        if (hits) return hits
      }
      return grepJs(pattern, prefix, maxHits)
    },

    async move(from, to, options = {}): Promise<MoveResult> {
      checkWritable(from)
      checkWritable(to)
      const realFrom = await guard.resolve(from)
      const realTo = await guard.resolve(to)
      const [first, second] = realFrom < realTo ? [realFrom, realTo] : [realTo, realFrom]
      return exclusive(first, () =>
        first === second ? moveLocked() : exclusive(second, () => moveLocked()),
      )

      async function moveLocked(): Promise<MoveResult> {
        const current = await currentVersion(realFrom)
        if (current === null) return { ok: false, reason: 'missing' }
        if (options.ifVersion !== undefined && current !== options.ifVersion) {
          return { ok: false, reason: 'conflict', currentVersion: current }
        }
        if (realFrom === realTo || (await currentVersion(realTo)) !== null) {
          return { ok: false, reason: 'exists' }
        }
        await mkdir(dirname(realTo), { recursive: true })
        await rename(realFrom, realTo)
        metaCache.delete(realFrom)
        return { ok: true }
      }
    },
  }
  return fs
}
