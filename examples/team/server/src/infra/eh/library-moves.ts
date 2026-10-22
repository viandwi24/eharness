/**
 * The moves an import applied (`library_moves`) and the lookups the redirects of the agents' file
 * system need: where did a path that no longer exists go.
 */
import type { Database } from 'bun:sqlite'
import {
  type LibraryMove,
  type MoveKind,
  type MoveRule,
  movedFolder,
  resolveMoved,
} from '../../domain/library-moves.ts'

interface Row {
  id: string
  from_path: string
  to_path: string
  kind: string
  at: number
  restore_point_id: string | null
  note: string | null
}

const toMove = (r: Row): LibraryMove => ({
  id: r.id,
  from: r.from_path,
  to: r.to_path,
  kind: r.kind as MoveKind,
  at: r.at,
  restorePointId: r.restore_point_id,
  note: r.note,
})

/** Every move, oldest first. */
export function listMoves(sqlite: Database): LibraryMove[] {
  return sqlite
    .query<Row, []>(
      'SELECT id, from_path, to_path, kind, at, restore_point_id, note FROM library_moves ORDER BY at, rowid',
    )
    .all()
    .map(toMove)
}

export function addMoves(sqlite: Database, moves: readonly LibraryMove[]): void {
  const insert = sqlite.query(
    `INSERT OR REPLACE INTO library_moves (id, from_path, to_path, kind, at, restore_point_id, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  sqlite.transaction(() => {
    for (const m of moves) {
      insert.run(m.id, m.from, m.to, m.kind, m.at, m.restorePointId, m.note)
    }
  })()
}

/** Forget the moves of one import (its undo). Returns how many. */
export function removeMovesOf(sqlite: Database, restorePointId: string): number {
  return sqlite.query('DELETE FROM library_moves WHERE restore_point_id = ?').run(restorePointId)
    .changes
}

const fileExists = (sqlite: Database, path: string): boolean =>
  sqlite.query('SELECT 1 FROM library_files WHERE path = ?').get(path) !== null

const folderHasFiles = (sqlite: Database, dir: string): boolean =>
  sqlite
    .query<{ path: string }, [string]>(
      'SELECT path FROM library_files WHERE path >= ?1 ORDER BY path LIMIT 1',
    )
    .get(dir)
    ?.path.startsWith(dir) === true

const anyMoves = (sqlite: Database): boolean =>
  sqlite.query('SELECT 1 FROM library_moves LIMIT 1').get() !== null

/**
 * Where a path that does not exist now was moved to, or undefined (the path exists, or no move
 * names it). The answer may itself not exist yet (a new file in a moved folder).
 */
export function movedTarget(sqlite: Database, path: string): string | undefined {
  if (!anyMoves(sqlite) || fileExists(sqlite, path)) return undefined
  const rules: MoveRule[] = listMoves(sqlite)
  return resolveMoved(path, rules, (p) => fileExists(sqlite, p))
}

/** Where an empty folder (`dir` ends with `/`) moved to, or undefined. */
export function movedFolderTarget(sqlite: Database, dir: string): string | undefined {
  if (!anyMoves(sqlite) || folderHasFiles(sqlite, dir)) return undefined
  return movedFolder(dir, listMoves(sqlite))
}
