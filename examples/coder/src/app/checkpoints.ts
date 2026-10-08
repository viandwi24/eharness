/**
 * Checkpoints and rewind (`/rewind`).
 *
 * `checkpointPlugin(store)` records, in `tool.before` of `edit_file`, `write_file` and
 * `delete_file`, the content of a file before the FIRST change in each turn, keyed by session id,
 * the turn's user message id and the virtual path. Stored under
 * `<projectDataDir>/checkpoints/<sessionId>/<userMessageId>.json` (the last 50 turns per session).
 *
 * Not checkpointed: changes made through the shell (`bash`, `!command`), other tools and edits
 * made outside the agent. Restoring only touches files the agent changed with the file tools.
 *
 * Integration: add `checkpointPlugin(store)` to EVERY agent (main and subagents: a subagent's
 * edits are filed under the user message of the root session's turn), build
 * `createCheckpoints({...})` once per controller, and use its `rewindPoints` / `rewind`.
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { definePlugin, isKindMessage } from 'eharness'
import { type FileSystem, normalizePath } from 'eharness/filesystem'
import { type CoderMessage, type RewindPoint, type RewindResult, TOOL } from '../contracts.ts'
import { copySession, messageText, type SessionStorage } from './session-tools.ts'
import { newSessionId } from './sessions.ts'

/** Turns kept per session. */
export const CHECKPOINT_KEEP = 50

/** Tools whose first change in a turn is recorded. */
export const CHECKPOINTED_TOOLS: readonly string[] = [TOOL.edit, TOOL.write, TOOL.delete]

/** What a file held before the first change of a turn. */
export type FileSnapshot = { existed: false } | { existed: true; content: string }

/** The file stored for one turn. */
export interface Checkpoint {
  v: 1
  sessionId: string
  /** The user message that started the turn. */
  userMessageId: string
  at: number
  /** Virtual path → content before the turn's first change. */
  files: Record<string, FileSnapshot>
}

/** Storage of checkpoints. */
export interface CheckpointStore {
  /** Record `path` for the turn unless it is already recorded. */
  record(sessionId: string, userMessageId: string, path: string): Promise<void>
  /** Checkpoints of a session, oldest first. */
  list(sessionId: string): Promise<Checkpoint[]>
  /** Delete the checkpoints of these user messages. */
  remove(sessionId: string, userMessageIds: string[]): Promise<void>
  /** Copy the checkpoints of these user messages into another session. */
  copy(from: string, to: string, userMessageIds: Iterable<string>): Promise<void>
  /** The user message of the latest turn started in this session (this process), if known. */
  currentTurn(sessionId: string): string | undefined
  /** Remember the user message of a turn (the plugin does it). */
  startTurn(sessionId: string, userMessageId: string): void
}

/** Options of {@link createCheckpointStore}. */
export interface CheckpointStoreOptions {
  /** `config.projectDataDir`. */
  projectDataDir: string
  /** The workspace file system (path guard applies); used to read files before they change. */
  fs: FileSystem
  /** Turns kept per session. Default {@link CHECKPOINT_KEEP}. */
  keep?: number
}

const safe = (id: string): string => encodeURIComponent(id)

/** Session id of the root (main) session: a subagent session id is `<parent>:agent:<call>`. */
function rootSession(id: string): string {
  const at = id.indexOf(':agent:')
  return at < 0 ? id : id.slice(0, at)
}

async function writeJson(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${crypto.randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(value), 'utf8')
  await rename(temp, file)
}

/** The store over JSON files. Writes are serialized inside the process. */
export function createCheckpointStore(opts: CheckpointStoreOptions): CheckpointStore {
  const base = join(opts.projectDataDir, 'checkpoints')
  const keep = opts.keep ?? CHECKPOINT_KEEP
  const dirOf = (sessionId: string): string => join(base, safe(sessionId))
  const fileOf = (sessionId: string, userMessageId: string): string =>
    join(dirOf(sessionId), `${safe(userMessageId)}.json`)
  const current = new Map<string, string>()
  let chain: Promise<unknown> = Promise.resolve()
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn)
    chain = run.catch(() => {})
    return run
  }

  const read = async (file: string): Promise<Checkpoint | undefined> => {
    try {
      const cp = JSON.parse(await readFile(file, 'utf8')) as Checkpoint
      return cp?.v === 1 && typeof cp.userMessageId === 'string' ? cp : undefined
    } catch {
      return undefined
    }
  }

  const names = async (sessionId: string): Promise<string[]> => {
    try {
      return (await readdir(dirOf(sessionId))).filter((n) => n.endsWith('.json')).sort()
    } catch {
      return []
    }
  }

  const list = async (sessionId: string): Promise<Checkpoint[]> => {
    const out: Checkpoint[] = []
    for (const name of await names(sessionId)) {
      const cp = await read(join(dirOf(sessionId), name))
      if (cp !== undefined) out.push(cp)
    }
    return out.sort((a, b) =>
      a.userMessageId < b.userMessageId ? -1 : a.userMessageId > b.userMessageId ? 1 : 0,
    )
  }

  const prune = async (sessionId: string): Promise<void> => {
    const all = await names(sessionId)
    for (const name of all.slice(0, Math.max(0, all.length - keep))) {
      await rm(join(dirOf(sessionId), name), { force: true })
    }
  }

  return {
    currentTurn: (sessionId) => current.get(sessionId),
    startTurn: (sessionId, userMessageId) => void current.set(sessionId, userMessageId),
    list,
    record: (sessionId, userMessageId, path) =>
      exclusive(async () => {
        const file = fileOf(sessionId, userMessageId)
        const existing = await read(file)
        if (existing?.files[path] !== undefined) return
        let snapshot: FileSnapshot
        try {
          const entry = await opts.fs.read(path)
          snapshot = entry === null ? { existed: false } : { existed: true, content: entry.content }
        } catch {
          return // unreadable (outside the workspace, binary…): nothing to restore later
        }
        const cp: Checkpoint = existing ?? {
          v: 1,
          sessionId,
          userMessageId,
          at: Date.now(),
          files: {},
        }
        cp.files[path] = snapshot
        await mkdir(dirOf(sessionId), { recursive: true })
        await writeJson(file, cp)
        if (existing === undefined) await prune(sessionId)
      }),
    remove: (sessionId, ids) =>
      exclusive(async () => {
        for (const id of ids) await rm(fileOf(sessionId, id), { force: true })
      }),
    copy: (from, to, ids) =>
      exclusive(async () => {
        for (const id of ids) {
          const cp = await read(fileOf(from, id))
          if (cp === undefined) continue
          await mkdir(dirOf(to), { recursive: true })
          await writeJson(fileOf(to, id), { ...cp, sessionId: to })
        }
        await prune(to)
      }),
  }
}

/**
 * The plugin (name `checkpoints`, no tools: the prompt prefix does not change). It needs the same
 * file system as the `filesystem()` plugin of the agent.
 */
export function checkpointPlugin(store: CheckpointStore): ReturnType<typeof definePlugin> {
  const watched = new Set(CHECKPOINTED_TOOLS)
  return definePlugin({
    name: 'checkpoints',
    setup: () => ({
      hooks: {
        'turn.start': (ctx, e) => {
          // subagent turns belong to the root session's turn; only a main turn with input starts one
          if (ctx.session.parent === undefined && e.input !== undefined) {
            store.startTurn(ctx.session.id, e.input.id)
          }
        },
        'tool.before': async (ctx, e) => {
          if (!watched.has(e.toolName)) return
          const raw = (e.input as { path?: unknown } | null | undefined)?.path
          if (typeof raw !== 'string') return
          const normalized = normalizePath(raw)
          if (!normalized.ok) return
          const root = rootSession(ctx.session.id)
          const userMessageId =
            ctx.session.parent === undefined && ctx.turn?.input !== undefined
              ? ctx.turn.input.id
              : store.currentTurn(root)
          if (userMessageId === undefined) return
          try {
            await store.record(root, userMessageId, normalized.path)
          } catch (error) {
            ctx.log.warn(`checkpoint failed for ${normalized.path}: ${String(error)}`)
          }
        },
      },
    }),
  })
}

// ─── rewind ──────────────────────────────────────────────────────────────────────────────────

/** Dependencies of {@link createCheckpoints}. */
export interface CheckpointsDeps {
  store: CheckpointStore
  storage: SessionStorage
  /** The workspace file system (`workspace.fs`): restoring goes through its path guard. */
  fs: FileSystem
  /** Current session id (the controller's `sessionId`). */
  sessionId: () => string
  /** Most rewind points listed. Default 50. */
  maxPoints?: number
}

export interface Checkpoints {
  plugin: ReturnType<typeof definePlugin>
  rewindPoints(): Promise<RewindPoint[]>
  /**
   * Rewind to just before the user message `messageId`. `conversation` returns the id of a NEW
   * session (messages before the point; the old session is untouched) that the caller switches to.
   */
  rewind(messageId: string, what: 'conversation' | 'code' | 'both'): Promise<RewindResult>
}

const rel = (path: string): string => path.replace(/^\/+/, '')

/** Wire the store, the plugin and the rewind operations. */
export function createCheckpoints(deps: CheckpointsDeps): Checkpoints {
  const { store, storage, fs } = deps
  const max = deps.maxPoints ?? CHECKPOINT_KEEP

  const userMessages = async (sessionId: string): Promise<CoderMessage[]> =>
    ((await storage.messages.load({ sessionId })) as CoderMessage[]).filter(
      (m) => m.role === 'user' && !isKindMessage(m),
    )

  const currentContent = async (path: string): Promise<string | null> => {
    try {
      return (await fs.read(path))?.content ?? null
    } catch {
      return null
    }
  }
  const differs = async (path: string, snap: FileSnapshot): Promise<boolean> => {
    const now = await currentContent(path)
    return snap.existed ? now !== snap.content : now !== null
  }

  /** Earliest snapshot per path among checkpoints[from..]. */
  const earliest = (cps: Checkpoint[]): Map<string, FileSnapshot> => {
    const out = new Map<string, FileSnapshot>()
    for (const cp of cps) {
      for (const [path, snap] of Object.entries(cp.files)) if (!out.has(path)) out.set(path, snap)
    }
    return out
  }

  return {
    plugin: checkpointPlugin(store),

    async rewindPoints() {
      const sessionId = deps.sessionId()
      const users = await userMessages(sessionId)
      const order = new Map(users.map((m, i) => [m.id, i]))
      const cps = (await store.list(sessionId)).filter((cp) => order.has(cp.userMessageId))
      const cache = new Map<string, boolean>()
      const changed = async (path: string, snap: FileSnapshot, key: string): Promise<boolean> => {
        const hit = cache.get(key)
        if (hit !== undefined) return hit
        const value = await differs(path, snap)
        cache.set(key, value)
        return value
      }
      const points: RewindPoint[] = []
      for (const message of users.slice(-max).reverse()) {
        const index = order.get(message.id) ?? 0
        const from = cps.filter((cp) => (order.get(cp.userMessageId) ?? -1) >= index)
        const files: string[] = []
        const seen = new Set<string>()
        for (const cp of from) {
          for (const [path, snap] of Object.entries(cp.files)) {
            if (seen.has(path)) continue
            seen.add(path)
            if (await changed(path, snap, `${path}\0${cp.userMessageId}`)) files.push(rel(path))
          }
        }
        points.push({
          messageId: message.id,
          text: messageText(message, '\n'),
          at:
            (message.metadata as { eharness?: { createdAt?: number } } | undefined)?.eharness
              ?.createdAt ?? uuidTime(message.id),
          files: files.sort(),
        })
      }
      return points
    },

    async rewind(messageId, what) {
      const sessionId = deps.sessionId()
      const users = await userMessages(sessionId)
      const index = users.findIndex((m) => m.id === messageId)
      const point = users[index]
      if (point === undefined) throw new Error(`No user message ${messageId} in this session.`)
      const result: RewindResult = { restoredFiles: [], prompt: messageText(point, '\n') }
      const later = new Set(users.slice(index).map((m) => m.id))
      const cps = await store.list(sessionId)

      if (what === 'conversation' || what === 'both') {
        const to = newSessionId()
        await copySession(storage, sessionId, to, { beforeId: messageId })
        await store.copy(
          sessionId,
          to,
          cps.map((cp) => cp.userMessageId).filter((id) => !later.has(id)),
        )
        result.sessionId = to
      }

      if (what === 'code' || what === 'both') {
        const affected = cps.filter((cp) => later.has(cp.userMessageId))
        for (const [path, snap] of earliest(affected)) {
          if (!(await differs(path, snap))) continue
          try {
            if (snap.existed) await fs.write(path, snap.content)
            else await fs.delete(path)
            result.restoredFiles.push(rel(path))
          } catch {
            // outside the workspace now, read-only or locked: left as it is
          }
        }
        result.restoredFiles.sort()
        // the files are back at the point: later checkpoints no longer describe them
        await store.remove(
          sessionId,
          affected.map((cp) => cp.userMessageId),
        )
      }
      return result
    },
  }
}

/** Epoch ms from a UUIDv7 id (0 when it is not one). */
function uuidTime(id: string): number {
  const ms = Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16)
  return Number.isFinite(ms) ? ms : 0
}
