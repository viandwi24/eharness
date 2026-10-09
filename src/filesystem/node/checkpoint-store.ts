/**
 * `nodeCheckpointStore(dir)`: a durable {@link CheckpointStore} over JSON files, one file per
 * turn: `<dir>/<sessionId>/<turnKey>.json` (ids are URI-encoded).
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type CheckpointRecord,
  type CheckpointStore,
  DEFAULT_CHECKPOINT_KEEP_TURNS,
  type FileSnapshot,
} from '../checkpoints.ts'
import { keyedMutex } from './mutex.ts'

/** Options of {@link nodeCheckpointStore}. */
export interface NodeCheckpointStoreOptions {
  /** Turns kept per session (the oldest are deleted on save). Default 50. */
  keepTurns?: number
}

interface TurnFile {
  v: 1
  sessionId: string
  turnKey: string
  files: Record<string, { before: FileSnapshot; at: number }>
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

async function writeJson(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(temp, JSON.stringify(value), 'utf8')
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Checkpoint store over JSON files in `dir` (created on first save). Survives restarts; writes
 * are serialized inside the process and atomic (temp file + rename). Not safe for several
 * processes writing the same turn: use a database-backed store for that.
 *
 * @example
 * ```ts
 * filesystem({ fs, checkpoints: nodeCheckpointStore('.agent/checkpoints') })
 * ```
 * @see docs/specs/08-filesystem-plugin.md#11-checkpoints
 */
export function nodeCheckpointStore(
  dir: string,
  opts: NodeCheckpointStoreOptions = {},
): CheckpointStore {
  const keep = opts.keepTurns ?? DEFAULT_CHECKPOINT_KEEP_TURNS
  const exclusive = keyedMutex()
  const sessionDir = (sessionId: string): string => join(dir, encodeURIComponent(sessionId))
  const fileOf = (sessionId: string, turnKey: string): string =>
    join(sessionDir(sessionId), `${encodeURIComponent(turnKey)}.json`)

  const read = async (file: string): Promise<TurnFile | undefined> => {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as TurnFile
      return parsed?.v === 1 && typeof parsed.turnKey === 'string' ? parsed : undefined
    } catch {
      return undefined
    }
  }

  const names = async (sessionId: string): Promise<string[]> => {
    try {
      return (await readdir(sessionDir(sessionId))).filter((n) => n.endsWith('.json')).sort()
    } catch {
      return []
    }
  }

  return {
    save: (key, before) =>
      exclusive(key.sessionId, async () => {
        const file = fileOf(key.sessionId, key.turnKey)
        const existing = await read(file)
        if (existing?.files[key.path] !== undefined) return
        const turn: TurnFile = existing ?? {
          v: 1,
          sessionId: key.sessionId,
          turnKey: key.turnKey,
          files: {},
        }
        turn.files[key.path] = { before, at: Date.now() }
        await mkdir(sessionDir(key.sessionId), { recursive: true })
        await writeJson(file, turn)
        if (existing === undefined) {
          const all = await names(key.sessionId)
          for (const name of all.slice(0, Math.max(0, all.length - keep))) {
            await rm(join(sessionDir(key.sessionId), name), { force: true })
          }
        }
      }),

    async load(key) {
      return (await read(fileOf(key.sessionId, key.turnKey)))?.files[key.path]?.before ?? null
    },

    async list(sessionId) {
      const out: CheckpointRecord[] = []
      for (const name of await names(sessionId)) {
        const turn = await read(join(sessionDir(sessionId), name))
        if (!turn) continue
        for (const [path, found] of Object.entries(turn.files)) {
          out.push({ turnKey: turn.turnKey, path, before: found.before, at: found.at })
        }
      }
      return out.sort((a, b) => byText(a.turnKey, b.turnKey) || byText(a.path, b.path))
    },

    delete: (sessionId, turnKeys) =>
      exclusive(sessionId, async () => {
        if (turnKeys === undefined) {
          await rm(sessionDir(sessionId), { recursive: true, force: true })
          return
        }
        for (const turnKey of turnKeys) await rm(fileOf(sessionId, turnKey), { force: true })
      }),
  }
}
