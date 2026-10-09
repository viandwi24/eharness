/**
 * Rewind (`/rewind`) and branch (`/branch`) on top of the library: file checkpoints are
 * `filesystem({ checkpoints })` + `rewindFiles` / `checkpointsSince`, the conversation is
 * `session.fork({ beforeMessageId })`. What stays here is policy: which points the UI lists, that
 * a rewind also covers the files subagents changed, and the copy of checkpoints into a fork.
 *
 * Not checkpointed (library rule): changes made through the shell (`bash`, `!command`), other
 * tools and edits made outside the agent.
 */
import { type HarnessSession, isKindMessage } from 'eharness'
import {
  type CheckpointStore,
  checkpointsSince,
  type FileSystem,
  rewindFiles,
} from 'eharness/filesystem'
import type { CoderMessage, RewindPoint, RewindResult } from '../contracts.ts'
import { messageText, type SessionStorage } from './session-tools.ts'

/** Most rewind points listed. */
export const MAX_REWIND_POINTS = 50

/** Dependencies of {@link createCheckpoints}. */
export interface CheckpointsDeps {
  store: CheckpointStore
  storage: SessionStorage
  /** The workspace file system (`workspace.fs`): restoring goes through its path guard. */
  fs: FileSystem
  /** The current session (the controller's). */
  session: () => Promise<HarnessSession<CoderMessage>>
  /** Most rewind points listed. Default {@link MAX_REWIND_POINTS}. */
  maxPoints?: number
}

export interface Checkpoints {
  rewindPoints(): Promise<RewindPoint[]>
  /**
   * Rewind to just before the user message `messageId`. `conversation` forks the session before
   * it and returns the id of the NEW session (the old one is untouched) for the caller to switch to.
   */
  rewind(messageId: string, what: 'conversation' | 'code' | 'both'): Promise<RewindResult>
  /** Copy the checkpoints of session `from` into `to` (a fork), only turns before `beforeKey`. */
  copy(from: string, to: string, beforeKey?: string): Promise<void>
}

const rel = (path: string): string => path.replace(/^\/+/, '')

/** Epoch ms from a UUIDv7 id (0 when it is not one). */
function uuidTime(id: string): number {
  const ms = Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16)
  return Number.isFinite(ms) ? ms : 0
}

/** Wire the store, the storage and the file system into the rewind operations. */
export function createCheckpoints(deps: CheckpointsDeps): Checkpoints {
  const { store, storage, fs } = deps
  const max = deps.maxPoints ?? MAX_REWIND_POINTS

  /**
   * A session and its descendants (subagent sessions): their edits are checkpointed under their
   * own session ids, with turn keys that sort after the parent turn that started them.
   */
  const family = async (id: string, depth = 0): Promise<string[]> => {
    const children = (await storage.state.get(id))?.core.children ?? []
    const nested =
      depth < 4 ? await Promise.all(children.map((c) => family(c.sessionId, depth + 1))) : []
    return [id, ...nested.flat()]
  }

  const userMessages = async (sessionId: string): Promise<CoderMessage[]> =>
    ((await storage.messages.load({ sessionId })) as CoderMessage[]).filter(
      (m) => m.role === 'user' && !isKindMessage(m),
    )

  const copy = async (from: string, to: string, beforeKey?: string): Promise<void> => {
    for (const r of await store.list(from)) {
      if (beforeKey !== undefined && r.turnKey >= beforeKey) continue
      await store.save({ sessionId: to, turnKey: r.turnKey, path: r.path }, r.before)
    }
  }

  return {
    copy,

    async rewindPoints() {
      const session = await deps.session()
      const sessions = await family(session.id)
      const users = (await userMessages(session.id)).slice(-max).reverse()
      const points: RewindPoint[] = []
      for (const message of users) {
        const files = new Set<string>()
        for (const sessionId of sessions) {
          const since = await checkpointsSince({ store, sessionId, fromTurnKey: message.id, fs })
          for (const cp of since) if (cp.changed !== false) files.add(rel(cp.path))
        }
        points.push({
          messageId: message.id,
          text: messageText(message, '\n'),
          at:
            (message.metadata as { eharness?: { createdAt?: number } } | undefined)?.eharness
              ?.createdAt ?? uuidTime(message.id),
          files: [...files].sort(),
        })
      }
      return points
    },

    async rewind(messageId, what) {
      const session = await deps.session()
      const point = (await userMessages(session.id)).find((m) => m.id === messageId)
      if (point === undefined) throw new Error(`No user message ${messageId} in this session.`)
      const result: RewindResult = { restoredFiles: [], prompt: messageText(point, '\n') }

      if (what === 'conversation' || what === 'both') {
        const forked = await session.fork({ beforeMessageId: messageId })
        // earlier turns keep their snapshots in the new session (copied before a code rewind drops them)
        await copy(session.id, forked.id, messageId)
        result.sessionId = forked.id
      }

      if (what === 'code' || what === 'both') {
        const touched = new Set<string>()
        for (const sessionId of await family(session.id)) {
          const out = await rewindFiles({ fs, store, sessionId, fromTurnKey: messageId })
          for (const path of [...out.restored, ...out.deleted]) touched.add(rel(path))
        }
        result.restoredFiles = [...touched].sort()
      }
      return result
    },
  }
}
