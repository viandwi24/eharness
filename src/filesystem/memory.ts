/**
 * `eharness/filesystem/memory`: the in-memory `FileSystem` adapter.
 *
 * Imports core only through `src/index.ts` (ADR-0008); pure (no Node built-ins).
 *
 * @see docs/specs/08-filesystem-plugin.md#6-inmemoryfs
 */

import { HarnessError } from '../index.ts'
import { detectMediaType, looksBinary } from './media.ts'
import { normalizePath } from './paths.ts'
import { GREP_SCAN_CHARS, splitLines, statelessPattern } from './text.ts'
import type {
  BinaryFile,
  DeleteResult,
  FileEntry,
  FileMeta,
  FileSystem,
  FileVersion,
  GrepHit,
  MoveResult,
  WriteResult,
} from './types.ts'
import { byteLength, bytesVersion, contentVersion } from './version.ts'

interface StoredFile {
  /** Text content; `''` for a binary file (see `bytes`). */
  content: string
  /** Raw bytes of a binary file; absent for text. */
  bytes?: Uint8Array
  version: string
  size: number
  updatedAt: number
  /** Declared by `writeBytes`; cleared by the next write without one. */
  mediaType?: string
}

/** One kept state of a file (`versions` / `readVersion`). */
interface HistoryEntry {
  file: StoredFile
  author?: string
}

/** Options of {@link inMemoryFs}. */
export interface InMemoryFsOptions {
  /** Initial files by path (`'src/a.md'` → `'/src/a.md'`); a `Uint8Array` that is not UTF-8 text is a binary file. */
  seed?: Record<string, string | Uint8Array>
  /** How many states per path `versions` keeps (oldest dropped first). Default 100. */
  maxVersions?: number
}

const decoder = new TextDecoder()
const encoder = new TextEncoder()

const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * In-memory {@link FileSystem}: a `Map` of normalized paths to text, versions via
 * `contentVersion` (SHA-1 of the content). Implements `stat`, `grep`, `move`, `readBytes` and
 * `writeBytes` (binary files: `read` throws for them, `grep` skips them; `Uint8Array` seed values
 * that are not UTF-8 text are binary). Not persistent;
 * used by tests, examples and demos. Conditional writes and moves are atomic (compare-and-set
 * without awaiting in between).
 *
 * Seed keys are normalized (`'src/a.md'` → `'/src/a.md'`); methods expect normalized paths like
 * every adapter (the plugin normalizes before calling).
 *
 * @example
 * ```ts
 * // inMemoryFs comes from the eharness/filesystem/memory subpath
 *
 * const fs = inMemoryFs({ seed: { '/README.md': '# Hello\n', '/skills/pine/SKILL.md': skillText } })
 * defineHarnessAgent({ model, plugins: [filesystem({ fs })] })
 * ```
 * @throws {TypeError} for an invalid seed path or a seed value that is neither a string nor a `Uint8Array`.
 * @see docs/specs/08-filesystem-plugin.md#6-inmemoryfs
 */
export function inMemoryFs(options: InMemoryFsOptions = {}): FileSystem {
  const seed = options.seed ?? {}
  const maxVersions = Math.max(1, options.maxVersions ?? 100)
  const files = new Map<string, StoredFile>()
  /** Kept states per path, oldest first; survives a delete, follows a move. */
  const history = new Map<string, HistoryEntry[]>()
  /** Set `files[path]` and record the state when its content differs from the last kept one. */
  const put = (path: string, file: StoredFile, author?: string): void => {
    files.set(path, file)
    const kept = history.get(path) ?? []
    if (kept.at(-1)?.file.version !== file.version) {
      kept.push({ file, ...(author === undefined ? {} : { author }) })
      if (kept.length > maxVersions) kept.splice(0, kept.length - maxVersions)
    }
    history.set(path, kept)
  }
  const initial: Array<[string, string | Uint8Array]> = []
  for (const [key, content] of Object.entries(seed)) {
    const normalized = normalizePath(key)
    if (!normalized.ok) {
      throw new HarnessError(
        'EH_CONFIG_INVALID',
        `inMemoryFs: invalid seed path ${JSON.stringify(key)}: ${normalized.error}`,
      )
    }
    if (typeof content !== 'string' && !(content instanceof Uint8Array)) {
      throw new HarnessError(
        'EH_CONFIG_INVALID',
        `inMemoryFs: seed content of ${normalized.path} must be a string or a Uint8Array`,
      )
    }
    initial.push([normalized.path, content])
  }
  const ready = (async () => {
    const now = Date.now()
    for (const [path, content] of initial) {
      put(path, { ...(await stored(content)), updatedAt: now })
    }
  })()

  /** Text, or bytes that are valid UTF-8 text, are stored as text; anything else as binary. */
  async function stored(content: string | Uint8Array): Promise<Omit<StoredFile, 'updatedAt'>> {
    if (typeof content === 'string') {
      return { content, version: await contentVersion(content), size: byteLength(content) }
    }
    if (!looksBinary(content)) {
      const text = decoder.decode(content)
      return { content: text, version: await contentVersion(text), size: content.byteLength }
    }
    return {
      content: '',
      bytes: content.slice(),
      version: await bytesVersion(content),
      size: content.byteLength,
    }
  }

  const meta = (path: string, file: StoredFile): FileMeta => ({
    path,
    version: file.version,
    size: file.size,
    updatedAt: file.updatedAt,
    ...(file.bytes === undefined ? {} : { binary: true }),
    ...(file.mediaType === undefined ? {} : { mediaType: file.mediaType }),
  })

  const listed = (prefix: string): Array<[string, StoredFile]> =>
    [...files.entries()]
      .filter(([path]) => path.startsWith(prefix))
      .sort(([a], [b]) => byPath(a, b))

  return {
    async read(path): Promise<FileEntry | null> {
      await ready
      const file = files.get(path)
      if (file === undefined) return null
      // plain-error: adapter I/O failure mapped to `ERROR: …` by the filesystem tools (spec 08)
      if (file.bytes !== undefined) throw new Error(`binary file: ${path} (use readBytes)`)
      return { ...meta(path, file), content: file.content }
    },

    async readBytes(path): Promise<BinaryFile | null> {
      await ready
      const file = files.get(path)
      if (file === undefined) return null
      const bytes = file.bytes === undefined ? encoder.encode(file.content) : file.bytes.slice()
      const mediaType = file.mediaType ?? detectMediaType(bytes, path)
      return { bytes, meta: meta(path, file), ...(mediaType === undefined ? {} : { mediaType }) }
    },

    async writeBytes(path, bytes, opts = {}): Promise<WriteResult> {
      if (!(bytes instanceof Uint8Array)) {
        throw new HarnessError(
          'EH_INVALID_INPUT',
          'inMemoryFs.writeBytes: bytes must be a Uint8Array',
        )
      }
      await ready
      const next = await stored(bytes)
      const current = files.get(path)
      if (opts.ifVersion === null && current !== undefined) {
        return { ok: false, reason: 'exists', currentVersion: current.version }
      }
      if (typeof opts.ifVersion === 'string' && current?.version !== opts.ifVersion) {
        return current === undefined
          ? { ok: false, reason: 'conflict' }
          : { ok: false, reason: 'conflict', currentVersion: current.version }
      }
      const mediaType =
        typeof opts.mediaType === 'string' && opts.mediaType !== '' ? opts.mediaType : undefined
      put(
        path,
        {
          ...next,
          updatedAt: Date.now(),
          ...(mediaType === undefined ? {} : { mediaType }),
        },
        opts.author,
      )
      return { ok: true, version: next.version }
    },

    async write(path, content, opts = {}): Promise<WriteResult> {
      if (typeof content !== 'string')
        throw new HarnessError('EH_INVALID_INPUT', 'inMemoryFs.write: content must be a string')
      await ready
      const version = await contentVersion(content)
      // compare-and-set without awaiting in between: atomic for concurrent callers
      const current = files.get(path)
      if (opts.ifVersion === null && current !== undefined) {
        return { ok: false, reason: 'exists', currentVersion: current.version }
      }
      if (typeof opts.ifVersion === 'string' && current?.version !== opts.ifVersion) {
        return current === undefined
          ? { ok: false, reason: 'conflict' }
          : { ok: false, reason: 'conflict', currentVersion: current.version }
      }
      put(path, { content, version, size: byteLength(content), updatedAt: Date.now() }, opts.author)
      return { ok: true, version }
    },

    async delete(path, opts = {}): Promise<DeleteResult> {
      await ready
      const current = files.get(path)
      if (current === undefined) return { ok: false, reason: 'missing' }
      if (opts.ifVersion !== undefined && current.version !== opts.ifVersion) {
        return { ok: false, reason: 'conflict', currentVersion: current.version }
      }
      files.delete(path)
      return { ok: true }
    },

    async list(prefix = '/'): Promise<FileMeta[]> {
      await ready
      return listed(prefix).map(([path, file]) => meta(path, file))
    },

    async stat(path): Promise<FileMeta | null> {
      await ready
      const file = files.get(path)
      return file === undefined ? null : meta(path, file)
    },

    async move(from, to, opts = {}): Promise<MoveResult> {
      await ready
      // compare-and-set without awaiting in between: atomic for concurrent callers
      const current = files.get(from)
      if (current === undefined) return { ok: false, reason: 'missing' }
      if (opts.ifVersion !== undefined && current.version !== opts.ifVersion) {
        return { ok: false, reason: 'conflict', currentVersion: current.version }
      }
      if (files.has(to)) return { ok: false, reason: 'exists' }
      files.delete(from)
      files.set(to, { ...current, updatedAt: Date.now() })
      const moved = history.get(from)
      history.delete(from)
      if (moved === undefined) history.delete(to)
      else history.set(to, moved)
      return { ok: true }
    },

    async versions(path): Promise<FileVersion[]> {
      await ready
      return [...(history.get(path) ?? [])].reverse().map(({ file, author }) => ({
        version: file.version,
        size: file.size,
        updatedAt: file.updatedAt,
        ...(file.bytes === undefined ? {} : { binary: true as const }),
        ...(file.mediaType === undefined ? {} : { mediaType: file.mediaType }),
        ...(author === undefined ? {} : { author }),
      }))
    },

    async readVersion(path, version): Promise<FileEntry | BinaryFile | null> {
      await ready
      const kept = history.get(path) ?? []
      const found = kept.findLast((entry) => entry.file.version === version)?.file
      if (found === undefined) return null
      if (found.bytes === undefined) return { ...meta(path, found), content: found.content }
      const mediaType = found.mediaType ?? detectMediaType(found.bytes, path)
      return {
        bytes: found.bytes.slice(),
        meta: meta(path, found),
        ...(mediaType === undefined ? {} : { mediaType }),
      }
    },

    async grep(pattern, opts = {}): Promise<GrepHit[]> {
      await ready
      const regex = statelessPattern(pattern)
      const maxHits = opts.maxHits ?? Number.POSITIVE_INFINITY
      const hits: GrepHit[] = []
      if (maxHits <= 0) return hits
      for (const [path, file] of listed(opts.prefix ?? '/')) {
        if (file.bytes !== undefined) continue // binary files are never searched
        const lines = splitLines(file.content)
        for (let i = 0; i < lines.length; i++) {
          const text = lines[i] as string
          // only the head of a very long line is scanned (bounded regex work, spec 08 §3)
          if (!regex.test(text.length > GREP_SCAN_CHARS ? text.slice(0, GREP_SCAN_CHARS) : text))
            continue
          hits.push({ path, line: i + 1, text })
          if (hits.length >= maxHits) return hits
        }
      }
      return hits
    },
  }
}
