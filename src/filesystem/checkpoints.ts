/**
 * File checkpoints (spec 08 §11): the content of a file before the first change of a turn, kept
 * in a {@link CheckpointStore} so an app can undo the agent's file edits.
 *
 * Independent of conversation rewind: the store is keyed by session id and turn key, and
 * {@link rewindFiles} only touches files.
 */
import type { FileSystem } from './types.ts'

/** What a file held before the first change of a turn. */
export type FileSnapshot = { content: string } | { missing: true }

/** Address of one snapshot. */
export interface CheckpointKey {
  sessionId: string
  /**
   * The turn: the id of the turn's user message, or the turn id when the turn has none
   * (`respond`, `regenerate`, wake). Both are UUIDv7, so keys sort by creation time.
   */
  turnKey: string
  /** Normalized absolute path. */
  path: string
}

/** A stored snapshot. */
export interface CheckpointRecord {
  turnKey: string
  path: string
  before: FileSnapshot
  /** When the snapshot was taken (ms since epoch). */
  at: number
}

/**
 * Durable storage of file checkpoints. Implement it over any backend (the same database as your
 * `StorageAdapter`, S3, …); `memoryCheckpointStore()` and `nodeCheckpointStore(dir)` are the
 * shipped ones.
 */
export interface CheckpointStore {
  /** Store `before` for the key. **First write wins**: an existing snapshot is kept. */
  save(key: CheckpointKey, before: FileSnapshot): Promise<void>
  /** The snapshot of a key, `null` when there is none. */
  load(key: CheckpointKey): Promise<FileSnapshot | null>
  /** All snapshots of a session, sorted by `turnKey` then `path` (code unit order). */
  list(sessionId: string): Promise<CheckpointRecord[]>
  /** Delete the snapshots of the given turns, or of the whole session when `turnKeys` is omitted. */
  delete(sessionId: string, turnKeys?: readonly string[]): Promise<void>
}

/** Options of {@link memoryCheckpointStore}. */
export interface MemoryCheckpointStoreOptions {
  /** Turns kept per session (the oldest are dropped). Default 50. */
  keepTurns?: number
}

/** Default turns kept per session by the shipped stores. */
export const DEFAULT_CHECKPOINT_KEEP_TURNS: number = 50

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * In-memory {@link CheckpointStore} (tests, single-process apps that do not need restarts).
 *
 * @see docs/specs/08-filesystem-plugin.md#11-checkpoints
 */
export function memoryCheckpointStore(opts: MemoryCheckpointStoreOptions = {}): CheckpointStore {
  const keep = opts.keepTurns ?? DEFAULT_CHECKPOINT_KEEP_TURNS
  const sessions = new Map<string, Map<string, Map<string, { before: FileSnapshot; at: number }>>>()
  return {
    async save(key, before) {
      const turns = sessions.get(key.sessionId) ?? new Map()
      sessions.set(key.sessionId, turns)
      const files = turns.get(key.turnKey) ?? new Map()
      turns.set(key.turnKey, files)
      if (!files.has(key.path))
        files.set(key.path, { before: structuredClone(before), at: Date.now() })
      const keys = [...turns.keys()].sort(byText)
      for (const old of keys.slice(0, Math.max(0, keys.length - keep))) turns.delete(old)
    },
    async load(key) {
      const found = sessions.get(key.sessionId)?.get(key.turnKey)?.get(key.path)
      return found ? structuredClone(found.before) : null
    },
    async list(sessionId) {
      const out: CheckpointRecord[] = []
      for (const [turnKey, files] of sessions.get(sessionId) ?? []) {
        for (const [path, found] of files) {
          out.push({ turnKey, path, before: structuredClone(found.before), at: found.at })
        }
      }
      return out.sort((a, b) => byText(a.turnKey, b.turnKey) || byText(a.path, b.path))
    },
    async delete(sessionId, turnKeys) {
      const turns = sessions.get(sessionId)
      if (!turns) return
      if (turnKeys === undefined) sessions.delete(sessionId)
      else for (const key of turnKeys) turns.delete(key)
    },
  }
}

/** The checkpoint key of a turn: its user message id, else the turn id (spec 08 §11). */
export function checkpointTurnKey(turn: {
  id: string
  input?: { id: string } | undefined
}): string {
  return turn.input?.id ?? turn.id
}

/** The earliest snapshot per path among the turns at or after `fromTurnKey`. */
export interface FileCheckpoint {
  path: string
  /** The turn that first changed the file at or after the point. */
  turnKey: string
  before: FileSnapshot
  /**
   * Whether the file differs from `before` now. Only set when `fs` was given; a file that cannot
   * be read counts as changed.
   */
  changed?: boolean
}

const sameAs = (current: string | null, before: FileSnapshot): boolean =>
  'missing' in before ? current === null : current === before.content

async function currentContent(fs: FileSystem, path: string): Promise<string | null | undefined> {
  try {
    return (await fs.read(path))?.content ?? null
  } catch {
    return undefined // unreadable (binary, too large, outside): unknown
  }
}

/**
 * The files an agent changed since a turn, for a UI ("these files will be restored"): the
 * earliest snapshot per path among the turns whose key is `>= fromTurnKey` (compared as strings;
 * keys are UUIDv7, so the point does not need a checkpoint of its own).
 *
 * @example
 * ```ts
 * const files = await checkpointsSince({ store, sessionId, fromTurnKey: userMessage.id, fs })
 * files.filter((f) => f.changed).map((f) => f.path)
 * ```
 */
export async function checkpointsSince(args: {
  store: CheckpointStore
  sessionId: string
  fromTurnKey: string
  /** When given, `changed` is computed against it. */
  fs?: FileSystem
}): Promise<FileCheckpoint[]> {
  const records = (await args.store.list(args.sessionId))
    .filter((r) => r.turnKey >= args.fromTurnKey)
    .sort((a, b) => byText(a.turnKey, b.turnKey))
  const earliest = new Map<string, CheckpointRecord>()
  for (const r of records) if (!earliest.has(r.path)) earliest.set(r.path, r)
  const out: FileCheckpoint[] = []
  for (const r of earliest.values()) {
    const item: FileCheckpoint = { path: r.path, turnKey: r.turnKey, before: r.before }
    if (args.fs) {
      const now = await currentContent(args.fs, r.path)
      item.changed = now === undefined || !sameAs(now, r.before)
    }
    out.push(item)
  }
  return out.sort((a, b) => byText(a.path, b.path))
}

/** Result of {@link rewindFiles}. */
export interface RewindFilesResult {
  /** Paths written back to their earlier content. */
  restored: string[]
  /** Paths deleted because they did not exist at the point. */
  deleted: string[]
  /** Paths that already had the earlier state. */
  unchanged: string[]
  /** Paths that could not be restored (read-only, outside the workspace, binary…). */
  failed: Array<{ path: string; error: string }>
}

/**
 * Put the files the agent changed back to the state before turn `fromTurnKey`: for every path
 * changed at or after the point, the earliest snapshot is restored (written back, or deleted if
 * the file did not exist). Goes through `fs`, so its containment and read-only rules apply; one
 * failing path does not stop the others.
 *
 * Unless `keepRecords` is true and when nothing failed, the snapshots of the rewound turns are
 * deleted: they no longer describe the files.
 *
 * Does not touch the conversation. Files changed by the shell, by other tools or outside the
 * agent are not tracked and not restored.
 *
 * @example
 * ```ts
 * const { restored, deleted } = await rewindFiles({
 *   fs, store, sessionId: session.id, fromTurnKey: userMessage.id,
 * })
 * ```
 * @see docs/specs/08-filesystem-plugin.md#11-checkpoints
 */
export async function rewindFiles(args: {
  fs: FileSystem
  store: CheckpointStore
  sessionId: string
  fromTurnKey: string
  /** Keep the snapshots after restoring. Default false. */
  keepRecords?: boolean
}): Promise<RewindFilesResult> {
  const result: RewindFilesResult = { restored: [], deleted: [], unchanged: [], failed: [] }
  const points = await checkpointsSince(args)
  for (const point of points) {
    const now = await currentContent(args.fs, point.path)
    if (now !== undefined && sameAs(now, point.before)) {
      result.unchanged.push(point.path)
      continue
    }
    try {
      if ('missing' in point.before) {
        const deleted = await args.fs.delete(point.path)
        if (deleted.ok) result.deleted.push(point.path)
        else if (deleted.reason === 'missing') result.unchanged.push(point.path)
        else result.failed.push({ path: point.path, error: deleted.reason })
      } else {
        const written = await args.fs.write(point.path, point.before.content)
        if (written.ok) result.restored.push(point.path)
        else result.failed.push({ path: point.path, error: written.reason })
      }
    } catch (error) {
      result.failed.push({
        path: point.path,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  if (!args.keepRecords && result.failed.length === 0) {
    const turns = new Set(points.map((p) => p.turnKey))
    const all = await args.store.list(args.sessionId)
    for (const r of all) if (r.turnKey >= args.fromTurnKey) turns.add(r.turnKey)
    if (turns.size > 0) await args.store.delete(args.sessionId, [...turns])
  }
  return result
}

/**
 * A file system that records the content of a path before its first change in a turn. Used by
 * the `filesystem()` plugin when `checkpoints` is set; exported for custom wiring.
 *
 * @param args.turnKey Current turn key, or `undefined` outside a turn (nothing is recorded).
 * @param args.skip Paths that are never recorded (e.g. the tool outputs directory).
 */
export function checkpointedFs(args: {
  fs: FileSystem
  store: CheckpointStore
  sessionId: string
  turnKey: () => string | undefined
  skip?: (path: string) => boolean
  onError?: (path: string, error: unknown) => void
}): FileSystem {
  const { fs, store, sessionId } = args
  const pending = new Map<string, Promise<void>>()
  let seenTurn: string | undefined

  const record = async (path: string): Promise<void> => {
    const turnKey = args.turnKey()
    if (turnKey === undefined || args.skip?.(path)) return
    if (turnKey !== seenTurn) {
      pending.clear()
      seenTurn = turnKey
    }
    let work = pending.get(path)
    if (!work) {
      work = (async () => {
        try {
          const key = { sessionId, turnKey, path }
          if ((await store.load(key)) !== null) return
          // binary files are not snapshotted (snapshots are text, spec 08 §11)
          if ((await fs.stat?.(path))?.binary === true) return
          const entry = await fs.read(path)
          await store.save(key, entry === null ? { missing: true } : { content: entry.content })
        } catch (error) {
          pending.delete(path) // retry on the next change
          args.onError?.(path, error)
        }
      })()
      pending.set(path, work)
    }
    await work
  }

  const wrapped: FileSystem = {
    read: (path) => fs.read(path),
    list: (prefix) => fs.list(prefix),
    async write(path, content, opts) {
      await record(path)
      return fs.write(path, content, opts)
    },
    async delete(path, opts) {
      await record(path)
      return fs.delete(path, opts)
    },
  }
  if (fs.readBytes) {
    wrapped.readBytes = (path) => (fs.readBytes as NonNullable<FileSystem['readBytes']>)(path)
  }
  if (fs.writeBytes) {
    wrapped.writeBytes = async (path, bytes, opts) => {
      await record(path)
      return (fs.writeBytes as NonNullable<FileSystem['writeBytes']>)(path, bytes, opts)
    }
  }
  if (fs.stat) wrapped.stat = (path) => (fs.stat as NonNullable<FileSystem['stat']>)(path)
  if (fs.grep)
    wrapped.grep = (pattern, o) => (fs.grep as NonNullable<FileSystem['grep']>)(pattern, o)
  if (fs.glob)
    wrapped.glob = (pattern, o) => (fs.glob as NonNullable<FileSystem['glob']>)(pattern, o)
  if (fs.move) {
    wrapped.move = async (from, to, opts) => {
      await record(from)
      await record(to)
      return (fs.move as NonNullable<FileSystem['move']>)(from, to, opts)
    }
  }
  return wrapped
}
