/**
 * `diskFs(root)`: the `FileSystem` contract over `node:fs/promises` (spec 08 §8).
 *
 * Containment is enforced on every call. Conditional writes are compare-and-set under a per-path
 * in-process mutex; writes go through a temp file and `rename`, keeping the file mode.
 */
import { spawn } from 'node:child_process'
import type { BigIntStats, Dirent } from 'node:fs'
import {
  access,
  chmod,
  constants,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { basename, delimiter, dirname, join } from 'node:path'
import { compileGlob } from '../glob.ts'
import { detectMediaType } from '../media.ts'
import type {
  BinaryFile,
  DeleteResult,
  FileEntry,
  FileMeta,
  FileSystem,
  GrepHit,
  MoveResult,
  WriteResult,
} from '../types.ts'
import { bytesVersion, contentVersion } from '../version.ts'
import { createGuard, isInside } from './guard.ts'
import { type IgnoreRules, loadIgnoreRules } from './ignore.ts'
import { keyedMutex } from './mutex.ts'

/** Default {@link DiskFsOptions.maxFileBytes}: 2 MiB. */
export const DEFAULT_MAX_FILE_BYTES: number = 2 * 1024 * 1024

/** Default {@link DiskFsOptions.maxBinaryBytes}: 10 MiB. */
export const DEFAULT_MAX_BINARY_BYTES: number = 10 * 1024 * 1024

/** Options of {@link diskFs}. */
export interface DiskFsOptions {
  /** `write`, `delete` and `move` throw `read-only directory: <path>`. */
  readonly?: boolean
  /** Which paths `list`, `grep` and `glob` hide (explicit reads still work). */
  ignore?: {
    /** Apply the root `.gitignore` (a subset, spec 08 §8). Default true. `.git/` and `node_modules/` are always hidden. */
    gitignore?: boolean
    /** Extra patterns in `.gitignore` syntax. */
    hidden?: string[]
  }
  /** Largest text file `read`, `list`, `grep` and `glob` handle. Default 2 MiB. */
  maxFileBytes?: number
  /** Largest binary file `readBytes` handles and `list` shows. Default 10 MiB. */
  maxBinaryBytes?: number
  /** `'auto'` (default): use ripgrep when it is on `PATH`, else JavaScript; `'js'`: never spawn. */
  grep?: 'auto' | 'js'
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true })

/** The decoded text of `bytes`, or `null` for a binary file (a NUL byte or invalid UTF-8). */
function decodeText(bytes: Uint8Array): string | null {
  if (bytes.subarray(0, 8000).includes(0)) return null
  try {
    return strictUtf8.decode(bytes)
  } catch {
    return null
  }
}

/** Version of file bytes: `contentVersion` of the text, `bytesVersion` of a binary file. */
async function versionOf(bytes: Uint8Array): Promise<{ version: string; binary: boolean }> {
  const text = decodeText(bytes)
  return text === null
    ? { version: await bytesVersion(bytes), binary: true }
    : { version: await contentVersion(text), binary: false }
}

const byPath = (a: { path: string }, b: { path: string }): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0

const isMissing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function formatLimit(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  if (mb >= 1) return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** First `name` on `PATH` that is executable, or `null`. */
async function which(name: string): Promise<string | null> {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter((d) => d !== '')
  const names = process.platform === 'win32' ? [`${name}.exe`, name] : [name]
  for (const dir of dirs) {
    for (const candidate of names) {
      const full = join(dir, candidate)
      try {
        await access(full, constants.X_OK)
        if ((await stat(full)).isFile()) return full
      } catch {
        // next
      }
    }
  }
  return null
}

/**
 * A `FileSystem` over a real directory.
 *
 * `read` throws a readable `Error` for binary files (`binary file: <path> …`, use `readBytes`) and
 * for text files over `maxFileBytes` (`too large file: <path> (text files up to 2 MB only)`); the
 * filesystem plugin turns adapter exceptions into `ERROR:` strings. `readBytes` / `writeBytes`
 * handle binary files up to `maxBinaryBytes`. Paths outside the root (including symlink escapes)
 * throw `path outside the workspace: <path>`. `list`, `glob` and `stat` skip hidden and oversized
 * files and show binary files (`binary: true`); `grep` skips binary files.
 *
 * @param root Real absolute directory; it is the virtual `/`.
 * @param opts See {@link DiskFsOptions}.
 * @example
 * ```ts
 * const fs = diskFs('/home/me/project', { ignore: { hidden: ['dist/'] } })
 * ```
 * @see docs/specs/08-filesystem-plugin.md#8-node-adapter
 */
export function diskFs(root: string, opts: DiskFsOptions = {}): FileSystem {
  const guard = createGuard(root)
  const exclusive = keyedMutex()
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  const maxBinary = Math.max(maxBytes, opts.maxBinaryBytes ?? DEFAULT_MAX_BINARY_BYTES)
  const metaCache = new Map<
    string,
    { mtimeNs: bigint; ino: bigint; size: number; version: string; binary: boolean }
  >()

  const tooLargeMessage = (path: string): string =>
    `too large file: ${path} (text files up to ${formatLimit(maxBytes)} only)`
  const binaryMessage = (path: string): string =>
    `binary file: ${path} (it cannot be read as text; use readBytes)`

  const checkWritable = (path: string): void => {
    if (opts.readonly) throw new Error(`read-only directory: ${path}`)
  }

  const rules = (real: string): Promise<IgnoreRules> => loadIgnoreRules(real, opts.ignore)

  /** Version of the current file content (text or binary), `null` when missing. */
  const currentVersion = async (real: string): Promise<string | null> => {
    try {
      const info = await stat(real)
      if (!info.isFile()) return null
      return (await versionOf(await readFile(real))).version
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  }

  const atomicWrite = async (real: string, content: string | Uint8Array): Promise<void> => {
    await mkdir(dirname(real), { recursive: true })
    const temp = join(dirname(real), `.${basename(real)}.${crypto.randomUUID().slice(0, 8)}.tmp`)
    // `rename` replaces the target's inode and would lose its mode (e.g. `+x`): carry it over.
    const mode = await stat(real)
      .then((info) => (info.isFile() ? info.mode & 0o7777 : null))
      .catch(() => null)
    try {
      await writeFile(temp, content)
      if (mode !== null) await chmod(temp, mode).catch(() => {}) // best effort
      await rename(temp, real)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {})
      throw error
    }
  }

  /**
   * Metadata of a regular file, `null` for anything else, for a text file over `maxFileBytes` and
   * for a file over `maxBinaryBytes` (cached by mtime/inode).
   */
  const metaOf = async (real: string, path: string): Promise<FileMeta | null> => {
    let info: BigIntStats
    try {
      info = await stat(real, { bigint: true })
    } catch {
      return null
    }
    if (!info.isFile() || info.size > BigInt(maxBinary)) return null
    const cached = metaCache.get(real)
    const updatedAt = Number(info.mtimeMs)
    const build = (v: { size: number; version: string; binary: boolean }): FileMeta | null =>
      !v.binary && v.size > maxBytes
        ? null // text over the text limit
        : {
            path,
            version: v.version,
            size: v.size,
            updatedAt,
            ...(v.binary ? { binary: true } : {}),
          }
    if (cached && cached.mtimeNs === info.mtimeNs && cached.ino === info.ino) return build(cached)
    try {
      const bytes = await readFile(real)
      const { version, binary } = await versionOf(bytes)
      const entry = { mtimeNs: info.mtimeNs, ino: info.ino, size: bytes.length, version, binary }
      metaCache.set(real, entry)
      return build(entry)
    } catch {
      return null // vanished
    }
  }

  /** Visible regular files below a virtual directory, as virtual paths with their real paths. */
  const walk = async (virtualDir: string): Promise<Array<{ path: string; real: string }>> => {
    const baseReal = await guard.resolve(virtualDir)
    const ignored = await rules(await guard.resolve('/'))
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

  const dirOf = (prefix: string): string =>
    prefix.endsWith('/') ? prefix : prefix.slice(0, prefix.lastIndexOf('/') + 1) || '/'
  const trimDir = (dir: string): string => (dir.length > 1 ? dir.slice(0, -1) : '/')

  const metas = async (files: Array<{ path: string; real: string }>): Promise<FileMeta[]> => {
    const out: FileMeta[] = []
    for (let i = 0; i < files.length; i += 64) {
      const chunk = await Promise.all(files.slice(i, i + 64).map((f) => metaOf(f.real, f.path)))
      for (const meta of chunk) if (meta) out.push(meta)
    }
    return out.sort(byPath)
  }

  const list = async (prefix = '/'): Promise<FileMeta[]> => {
    const files = (await walk(trimDir(dirOf(prefix)))).filter((f) => f.path.startsWith(prefix))
    return metas(files)
  }

  const grepJs = async (pattern: RegExp, prefix: string, maxHits: number): Promise<GrepHit[]> => {
    const re = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''))
    const hits: GrepHit[] = []
    for (const meta of await list(prefix)) {
      if (meta.binary) continue
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
    const realRoot = await guard.resolve('/')
    const realDir = await guard.resolve(trimDir(dirOf(prefix)))
    const hidden = await rules(realRoot)
    // `--no-ignore`: the ignore rules are ours (one subset for rg and the JS path); rg only
    // skips the always-hidden directories to avoid walking them.
    const args = [
      '--json',
      '--hidden',
      '--no-ignore',
      '--no-messages',
      '--max-filesize',
      String(maxBytes),
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
    if (output.code !== 0 && output.code !== 1) return null // pattern rg cannot compile etc.
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
      const rel = file
        .slice(realRoot.length)
        .replace(/^[\\/]+/, '')
        .split('\\')
        .join('/')
      if (hidden.isHidden(rel, false) || rel.split('/').some((s) => s === '..')) continue
      const path = `/${rel}`
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
      if (!info.isFile()) throw new Error(binaryMessage(path))
      if (info.size > maxBinary) throw new Error(tooLargeMessage(path))
      const bytes = await readFile(real)
      const content = decodeText(bytes)
      if (content === null) throw new Error(binaryMessage(path))
      if (bytes.length > maxBytes) throw new Error(tooLargeMessage(path))
      return {
        path,
        content,
        version: await contentVersion(content),
        size: bytes.length,
        updatedAt: info.mtimeMs,
      }
    },

    async readBytes(path): Promise<BinaryFile | null> {
      const real = await guard.resolve(path)
      let info: Awaited<ReturnType<typeof stat>>
      try {
        info = await stat(real)
      } catch (error) {
        if (isMissing(error)) return null
        throw error
      }
      if (info.isDirectory()) return null
      if (!info.isFile()) throw new Error(binaryMessage(path))
      if (info.size > maxBinary) {
        throw new Error(`too large file: ${path} (up to ${formatLimit(maxBinary)} only)`)
      }
      const bytes = new Uint8Array(await readFile(real))
      const { version, binary } = await versionOf(bytes)
      const mediaType = detectMediaType(bytes, path)
      return {
        bytes,
        meta: {
          path,
          version,
          size: bytes.length,
          updatedAt: info.mtimeMs,
          ...(binary ? { binary: true } : {}),
        },
        ...(mediaType === undefined ? {} : { mediaType }),
      }
    },

    async writeBytes(path, bytes, options = {}): Promise<WriteResult> {
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
        await atomicWrite(real, bytes)
        return { ok: true, version: (await versionOf(bytes)).version }
      })
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
      // flags other than `i` change the match semantics in ways rg cannot reproduce
      if (opts.grep !== 'js' && pattern.flags.replace(/[gyi]/g, '') === '') {
        const rg = await which('rg')
        if (rg) {
          const hits = await grepRg(rg, pattern, prefix, maxHits).catch(() => null)
          if (hits) return hits
        }
      }
      return grepJs(pattern, prefix, maxHits)
    },

    async glob(pattern, options): Promise<FileMeta[]> {
      const compiled = compileGlob(pattern)
      if (!compiled.ok) return []
      const prefix = options.prefix
      const matched = (await walk(trimDir(dirOf(prefix)))).filter(
        (f) => f.path.startsWith(prefix) && compiled.test(f.path.slice(prefix.length)),
      )
      matched.sort(byPath)
      return (await metas(matched)).slice(0, options.limit)
    },

    async move(from, to, options = {}): Promise<MoveResult> {
      checkWritable(from)
      checkWritable(to)
      const realFrom = await guard.resolve(from)
      const realTo = await guard.resolve(to)
      const [first, second] = realFrom < realTo ? [realFrom, realTo] : [realTo, realFrom]
      const moveLocked = async (): Promise<MoveResult> => {
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
      return exclusive(first, () =>
        first === second ? moveLocked() : exclusive(second, () => moveLocked()),
      )
    },
  }
  return fs
}
