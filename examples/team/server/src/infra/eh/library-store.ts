/**
 * The library and memory files as the HTTP routes see them: list with creator, read (text or
 * bytes), conditional text writes by a person, delete, move and the version history. Writes go
 * through the same `FileSystem` the agents use, so `ifVersion` makes a stale edit lose to an agent
 * write on any instance, and every change reaches the event feed through `onChange`.
 */
import type { Database } from 'bun:sqlite'
import type { FileChange, LibraryStore } from '../../app/ports.ts'
import type { LibraryFileMeta, LibraryVersion } from '../../domain/library.ts'
import { type LibraryChange, libraryFs } from './library-fs.ts'

interface MetaRow {
  path: string
  version: string
  size: number
  media_type: string | null
  binary: number
  created_by_agent_id: string | null
  updated_at: number
}

const toMeta = (r: MetaRow): LibraryFileMeta => ({
  path: r.path,
  version: r.version,
  size: r.size,
  mediaType: r.media_type,
  binary: r.binary === 1,
  createdByAgentId: r.created_by_agent_id,
  updatedAt: r.updated_at,
})

const like = (prefix: string): string => `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

export function sqliteLibraryStore(
  sqlite: Database,
  options: { onChange?: (change: LibraryChange) => void } = {},
): LibraryStore {
  // no agentId: a change through this store is a person's
  const fs = libraryFs(sqlite, options.onChange ? { onChange: options.onChange } : {})
  const write = fs.write.bind(fs)
  const del = fs.delete.bind(fs)
  const move = fs.move?.bind(fs)

  return {
    list({ prefix, excludePrefixes = [], createdBy, newestFirst, limit }) {
      const where = [`path LIKE ? ESCAPE '\\'`]
      const params: Array<string | number> = [like(prefix)]
      for (const ex of excludePrefixes) {
        where.push(`path NOT LIKE ? ESCAPE '\\'`)
        params.push(like(ex))
      }
      if (createdBy !== undefined) {
        where.push('created_by_agent_id = ?')
        params.push(createdBy)
      }
      return (
        sqlite
          .query<MetaRow, Array<string | number>>(
            `SELECT path, version, size, media_type, bytes IS NOT NULL AS binary,
                  created_by_agent_id, updated_at
             FROM library_files WHERE ${where.join(' AND ')}
            ORDER BY ${newestFirst === true ? 'updated_at DESC, path' : 'path'} LIMIT ?`,
          )
          .all(...params, limit)
          // `LIKE` is case-insensitive for ASCII: keep exact-prefix matches only
          .filter((r) => r.path.startsWith(prefix))
          .map(toMeta)
      )
    },

    async read(path) {
      const row = sqlite
        .query<MetaRow & { text: string | null; bytes: Uint8Array | null }, [string]>(
          `SELECT path, version, size, media_type, bytes IS NOT NULL AS binary,
                  created_by_agent_id, updated_at, text, bytes
             FROM library_files WHERE path = ?`,
        )
        .get(path)
      if (row === null) return undefined
      return {
        meta: toMeta(row),
        text: row.bytes === null ? (row.text ?? '') : null,
        bytes: row.bytes === null ? null : new Uint8Array(row.bytes),
      }
    },

    async writeText(path, content, ifVersion): Promise<FileChange> {
      const result = await write(path, content, ifVersion === undefined ? {} : { ifVersion })
      return result.ok
        ? { ok: true, version: result.version }
        : {
            ok: false,
            reason: result.reason,
            ...(result.currentVersion === undefined
              ? {}
              : { currentVersion: result.currentVersion }),
          }
    },

    async delete(path, ifVersion): Promise<FileChange> {
      const result = await del(path, ifVersion === undefined ? {} : { ifVersion })
      return result.ok
        ? { ok: true, version: '' }
        : {
            ok: false,
            reason: result.reason,
            ...(result.currentVersion === undefined
              ? {}
              : { currentVersion: result.currentVersion }),
          }
    },

    async move(from, to, ifVersion): Promise<FileChange> {
      if (move === undefined) throw new Error('the library file store cannot move files')
      const result = await move(from, to, ifVersion === undefined ? {} : { ifVersion })
      return result.ok
        ? { ok: true, version: '' }
        : {
            ok: false,
            reason: result.reason,
            ...(result.currentVersion === undefined
              ? {}
              : { currentVersion: result.currentVersion }),
          }
    },

    versions(path, limit): LibraryVersion[] {
      return sqlite
        .query<
          {
            seq: number
            action: string
            version: string | null
            size: number | null
            from_path: string | null
            agent_id: string | null
            at: number
          },
          [string, number]
        >(
          `SELECT seq, action, version, size, from_path, agent_id, at
             FROM library_history WHERE path = ? ORDER BY seq DESC LIMIT ?`,
        )
        .all(path, limit)
        .map((r) => ({
          seq: r.seq,
          action: r.action as LibraryVersion['action'],
          version: r.version,
          size: r.size,
          fromPath: r.from_path,
          agentId: r.agent_id,
          at: r.at,
        }))
    },
  }
}
