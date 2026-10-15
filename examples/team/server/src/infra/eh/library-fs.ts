/**
 * DB-backed `FileSystem` (spec 08) over the `library_files` table: the shared Library of agent
 * artifacts and, under `/memories/**`, the memory files (docs/plans/P32-team-example.md §6.3).
 *
 * Text and binary files, versions as SHA-1 content hashes (`contentVersion` / `bytesVersion`),
 * `list` / `stat` / `grep` / `glob` / `move`. Conditional writes are compare-and-set inside one
 * `BEGIN IMMEDIATE` transaction, so a stale edit loses to a concurrent write on any instance.
 * Hashing happens before the transaction (Web Crypto is async; SQLite calls are synchronous).
 */
import type { Database } from 'bun:sqlite'
import {
  type BinaryFile,
  bytesVersion,
  compileGlob,
  contentVersion,
  type DeleteResult,
  detectMediaType,
  type FileEntry,
  type FileMeta,
  type FileSystem,
  type GrepHit,
  looksBinary,
  type MoveResult,
  type WriteResult,
} from 'eharness/filesystem'

interface Row {
  path: string
  version: string
  text: string | null
  bytes: Uint8Array | null
  media_type: string | null
  size: number
  created_by_agent_id: string | null
  updated_at: number
}

export interface LibraryChange {
  action: 'write' | 'delete' | 'move'
  path: string
  to?: string
  version: string | null
  agentId: string | null
}

/** Where the core's `toolMedia` service keeps the media of MCP tool results (a library folder). */
export const TOOL_MEDIA_DIR = '/.eharness/tool-media'

export interface LibraryFsOptions {
  /** Stored as the author (the latest writer; none = a person) of files this instance writes. */
  agentId?: string
  /** Called after every successful write, delete or move (event feed hook, M4). */
  onChange?: (change: LibraryChange) => void
}

const decoder = new TextDecoder('utf-8', { fatal: false })
const encoder = new TextEncoder()
const GREP_SCAN_CHARS = 2_000

const metaOf = (
  row: Pick<Row, 'path' | 'version' | 'size' | 'updated_at' | 'bytes' | 'media_type'>,
): FileMeta => ({
  path: row.path,
  version: row.version,
  size: row.size,
  updatedAt: row.updated_at,
  ...(row.bytes !== null ? { binary: true } : {}),
  ...(row.media_type !== null ? { mediaType: row.media_type } : {}),
})

/** SQL `LIKE` pattern matching `prefix` literally (escape `%`, `_` and `\`). */
const likePrefix = (prefix: string): string => `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

const HISTORY_KEEP = 100

const META_COLS = 'path, version, size, updated_at, bytes IS NOT NULL AS has_bytes, media_type'

export function libraryFs(sqlite: Database, options: LibraryFsOptions = {}): FileSystem {
  const agentId = options.agentId ?? null

  type MetaRow = Omit<Row, 'text' | 'bytes' | 'created_by_agent_id'> & { has_bytes: number }
  const toMeta = (row: MetaRow): FileMeta =>
    metaOf({ ...row, bytes: row.has_bytes === 1 ? new Uint8Array(0) : null })

  /** Metadata-only history of a path, written in the same transaction as the change. */
  const record = (e: {
    path: string
    action: 'write' | 'delete' | 'move'
    version: string | null
    size: number | null
    fromPath?: string
  }): void => {
    sqlite
      .query(
        `INSERT INTO library_history (path, action, version, size, from_path, agent_id, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.path, e.action, e.version, e.size, e.fromPath ?? null, agentId, Date.now())
    sqlite
      .query(
        `DELETE FROM library_history WHERE path = ?1 AND seq NOT IN
           (SELECT seq FROM library_history WHERE path = ?1 ORDER BY seq DESC LIMIT ${HISTORY_KEEP})`,
      )
      .run(e.path)
  }

  const current = (path: string): { version: string } | null =>
    sqlite
      .query<{ version: string }, [string]>('SELECT version FROM library_files WHERE path = ?')
      .get(path)

  /** The conditional-write core shared by `write` and `writeBytes`. */
  function put(
    path: string,
    stored: {
      version: string
      text: string | null
      bytes: Uint8Array | null
      size: number
      mediaType: string | null
    },
    ifVersion: string | null | undefined,
  ): WriteResult {
    const result = sqlite
      .transaction((): WriteResult => {
        const cur = current(path)
        if (ifVersion === null && cur !== null) {
          return { ok: false, reason: 'exists', currentVersion: cur.version }
        }
        if (typeof ifVersion === 'string' && cur?.version !== ifVersion) {
          return cur === null
            ? { ok: false, reason: 'conflict' }
            : { ok: false, reason: 'conflict', currentVersion: cur.version }
        }
        sqlite
          .query(
            `INSERT INTO library_files
               (path, version, text, bytes, media_type, size, created_by_agent_id, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (path) DO UPDATE SET
               version = excluded.version, text = excluded.text, bytes = excluded.bytes,
               media_type = excluded.media_type, size = excluded.size,
               created_by_agent_id = excluded.created_by_agent_id, updated_at = excluded.updated_at`,
          )
          .run(
            path,
            stored.version,
            stored.text,
            stored.bytes,
            stored.mediaType,
            stored.size,
            agentId,
            Date.now(),
          )
        record({ path, action: 'write', version: stored.version, size: stored.size })
        return { ok: true, version: stored.version }
      })
      .immediate()
    if (result.ok) options.onChange?.({ action: 'write', path, version: result.version, agentId })
    return result
  }

  const listRows = (prefix: string): MetaRow[] =>
    sqlite
      .query<MetaRow, [string]>(
        `SELECT ${META_COLS} FROM library_files WHERE path LIKE ? ESCAPE '\\' ORDER BY path`,
      )
      .all(likePrefix(prefix))
      // `LIKE` is case-insensitive for ASCII: keep exact-prefix matches only
      .filter((row) => row.path.startsWith(prefix))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  return {
    async read(path): Promise<FileEntry | null> {
      const row = sqlite
        .query<Row, [string]>('SELECT * FROM library_files WHERE path = ?')
        .get(path)
      if (row === null) return null
      if (row.bytes !== null) throw new Error(`binary file: ${path} (use readBytes)`)
      return { ...metaOf(row), content: row.text ?? '' }
    },

    async readBytes(path): Promise<BinaryFile | null> {
      const row = sqlite
        .query<Row, [string]>('SELECT * FROM library_files WHERE path = ?')
        .get(path)
      if (row === null) return null
      const bytes = row.bytes !== null ? new Uint8Array(row.bytes) : encoder.encode(row.text ?? '')
      const mediaType = row.media_type ?? detectMediaType(bytes, path)
      return { bytes, meta: metaOf(row), ...(mediaType === undefined ? {} : { mediaType }) }
    },

    async write(path, content, opts = {}): Promise<WriteResult> {
      if (typeof content !== 'string')
        throw new TypeError('libraryFs.write: content must be a string')
      const version = await contentVersion(content)
      return put(
        path,
        {
          version,
          text: content,
          bytes: null,
          size: encoder.encode(content).byteLength,
          mediaType: detectMediaType(encoder.encode(content.slice(0, 512)), path) ?? null,
        },
        opts.ifVersion,
      )
    },

    async writeBytes(path, bytes, opts = {}): Promise<WriteResult> {
      if (!(bytes instanceof Uint8Array)) {
        throw new TypeError('libraryFs.writeBytes: bytes must be a Uint8Array')
      }
      // a declared media type wins (spec 08 §4: text/csv of a text file), else detection
      const mediaType = opts.mediaType ?? detectMediaType(bytes, path) ?? null
      if (!looksBinary(bytes)) {
        // valid UTF-8 text is stored as a text file (spec 08 §12)
        const text = decoder.decode(bytes)
        return put(
          path,
          {
            version: await contentVersion(text),
            text,
            bytes: null,
            size: bytes.byteLength,
            mediaType,
          },
          opts.ifVersion,
        )
      }
      return put(
        path,
        {
          version: await bytesVersion(bytes),
          text: null,
          bytes: bytes.slice(),
          size: bytes.byteLength,
          mediaType,
        },
        opts.ifVersion,
      )
    },

    async delete(path, opts = {}): Promise<DeleteResult> {
      const result = sqlite
        .transaction((): DeleteResult => {
          const cur = current(path)
          if (cur === null) return { ok: false, reason: 'missing' }
          if (opts.ifVersion !== undefined && cur.version !== opts.ifVersion) {
            return { ok: false, reason: 'conflict', currentVersion: cur.version }
          }
          sqlite.query('DELETE FROM library_files WHERE path = ?').run(path)
          record({ path, action: 'delete', version: null, size: null })
          return { ok: true }
        })
        .immediate()
      if (result.ok) options.onChange?.({ action: 'delete', path, version: null, agentId })
      return result
    },

    async list(prefix = '/'): Promise<FileMeta[]> {
      return listRows(prefix).map(toMeta)
    },

    async stat(path): Promise<FileMeta | null> {
      const row = sqlite
        .query<MetaRow, [string]>(`SELECT ${META_COLS} FROM library_files WHERE path = ?`)
        .get(path)
      return row === null ? null : toMeta(row)
    },

    async move(from, to, opts = {}): Promise<MoveResult> {
      const result = sqlite
        .transaction((): MoveResult => {
          const cur = current(from)
          if (cur === null) return { ok: false, reason: 'missing' }
          if (opts.ifVersion !== undefined && cur.version !== opts.ifVersion) {
            return { ok: false, reason: 'conflict', currentVersion: cur.version }
          }
          if (current(to) !== null) return { ok: false, reason: 'exists' }
          sqlite
            .query('UPDATE library_files SET path = ?, updated_at = ? WHERE path = ?')
            .run(to, Date.now(), from)
          record({ path: to, action: 'move', version: cur.version, size: null, fromPath: from })
          return { ok: true }
        })
        .immediate()
      if (result.ok) {
        options.onChange?.({ action: 'move', path: from, to, version: null, agentId })
      }
      return result
    },

    async grep(pattern, opts = {}): Promise<GrepHit[]> {
      const regex = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''))
      const maxHits = opts.maxHits ?? Number.POSITIVE_INFINITY
      const hits: GrepHit[] = []
      if (maxHits <= 0) return hits
      const prefix = opts.prefix ?? '/'
      // text files only, in path order; rows are streamed so a big library is not loaded at once
      const rows = sqlite
        .query<{ path: string; text: string }, [string]>(
          `SELECT path, text FROM library_files
           WHERE text IS NOT NULL AND path LIKE ? ESCAPE '\\' ORDER BY path`,
        )
        .iterate(likePrefix(prefix))
      const sorted = [...rows]
        .filter((row) => row.path.startsWith(prefix))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      for (const row of sorted) {
        const lines = row.text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
        for (let i = 0; i < lines.length; i++) {
          const text = lines[i] as string
          if (!regex.test(text.length > GREP_SCAN_CHARS ? text.slice(0, GREP_SCAN_CHARS) : text))
            continue
          hits.push({ path: row.path, line: i + 1, text })
          if (hits.length >= maxHits) return hits
        }
      }
      return hits
    },

    async glob(pattern, opts): Promise<FileMeta[]> {
      const compiled = compileGlob(pattern)
      if (!compiled.ok) return []
      const out: FileMeta[] = []
      for (const row of listRows(opts.prefix)) {
        if (!compiled.test(row.path.slice(opts.prefix.length))) continue
        out.push(toMeta(row))
        if (out.length >= opts.limit) break
      }
      return out
    },
  }
}
