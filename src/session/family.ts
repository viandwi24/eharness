/**
 * Session families (internal): the parent/child index (`core.parent`, `core.children`, spec 05
 * §13) and the message and state copy of `session.fork()` (spec 05 §14).
 *
 * @see docs/specs/05-session-and-storage.md#13-parent-and-child-sessions
 * @see docs/specs/05-session-and-storage.md#14-fork
 */
import type {
  ChildSessionInfo,
  MessageAdapter,
  SessionStateSnapshot,
  StateAdapter,
} from '../agent/session-types.ts'
import { HarnessError, isHarnessError } from '../errors.ts'
import type { MessageRegistry } from '../messages/registry.ts'
import type { CompactionPayload, HarnessUIMessage } from '../messages/types.ts'
import { isBoundary, rewindsIn } from './load-context.ts'

/** Entries `core.children` keeps (the oldest are dropped). */
export const MAX_CHILDREN = 500
/** Conflicting registrations retried (re-read) before giving up. */
const REGISTER_RETRIES = 12
/** Messages copied per batch by a fork. */
export const FORK_PAGE_SIZE = 200

function storageError(what: string, cause: unknown): HarnessError {
  if (isHarnessError(cause)) return cause
  return new HarnessError('EH_STORAGE', `State storage failed (${what}).`, { cause })
}

/**
 * Append `entry` to `core.children` of the parent's stored state (a foreign write, spec 05 §13):
 * read, append (deduplicated by session id, capped at {@link MAX_CHILDREN}) and write with
 * `setIf(rev)`, re-reading on conflict (at most 12 retries, with a short random backoff). Without `setIf` the write is a plain
 * read-modify-write (a concurrent registration may be lost). A parent without stored state is
 * not created (`'no-parent'`). Throws `EH_STORAGE`, or `EH_SESSION_BUSY` when every retry
 * conflicted.
 */
export async function registerChild(
  adapter: StateAdapter,
  parentSessionId: string,
  entry: ChildSessionInfo,
): Promise<'registered' | 'exists' | 'no-parent'> {
  for (let attempt = 0; attempt <= REGISTER_RETRIES; attempt++) {
    try {
      const stored = await adapter.get(parentSessionId)
      if (stored === null) return 'no-parent'
      const children = stored.core?.children ?? []
      if (children.some((c) => c.sessionId === entry.sessionId)) return 'exists'
      const rev = typeof stored.rev === 'number' ? stored.rev : 0
      const next: SessionStateSnapshot = structuredClone({
        ...stored,
        rev: rev + 1,
        core: { ...stored.core, children: [...children, entry].slice(-MAX_CHILDREN) },
      })
      if (adapter.setIf === undefined) {
        await adapter.set(parentSessionId, next)
        return 'registered'
      }
      if (await adapter.setIf(parentSessionId, next, rev)) return 'registered'
      // lost the race: back off a little so concurrent children do not retry in lockstep
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 4 * (attempt + 1)))
    } catch (error) {
      throw storageError('register child', error)
    }
  }
  throw new HarnessError(
    'EH_SESSION_BUSY',
    `Could not register the child in the state of session '${parentSessionId}' (conflicting writes).`,
    { details: { sessionId: parentSessionId } },
  )
}

/** What {@link copyMessages} found while copying. */
export interface CopiedHistory {
  /** Number of messages copied. */
  count: number
  /** Ids of the copied messages (newest batch first). */
  ids: string[]
  /** Newest copied compaction boundary, as the state pointer. */
  compaction?: { markerId: string; resumeFromId: string | null }
  /** Rewind markers among the copied messages, chronological. */
  rewinds: Array<{ afterId: string | null; rewindId: string }>
}

/**
 * Copy the messages of `from` with an id before `beforeId` (all when omitted) into `to`, newest
 * batch first, `FORK_PAGE_SIZE` at a time through `load({ beforeId, limit })`, keeping the ids.
 * Boundary and rewind markers are copied as they are: the copy is a strict prefix, so a marker
 * never points past the cut (a rewind or compaction marker after the cut is simply not copied).
 */
export async function copyMessages(args: {
  adapter: MessageAdapter
  from: string
  to: string
  beforeId?: string
  registry: MessageRegistry
}): Promise<CopiedHistory> {
  const { adapter, registry } = args
  const out: CopiedHistory = { count: 0, ids: [], rewinds: [] }
  let cursor = args.beforeId
  try {
    for (;;) {
      const raw = (await adapter.load({
        sessionId: args.from,
        limit: FORK_PAGE_SIZE,
        ...(cursor === undefined ? {} : { beforeId: cursor }),
      })) as HarnessUIMessage[]
      // never trust an adapter to honour beforeId (no duplicates, no endless loop)
      const page = cursor === undefined ? raw : raw.filter((m) => m.id < (cursor as string))
      if (page.length === 0) break
      await adapter.save(args.to, structuredClone(page))
      out.count += page.length
      for (const m of page) out.ids.push(m.id)
      out.rewinds.unshift(...rewindsIn(page))
      if (out.compaction === undefined) {
        for (let i = page.length - 1; i >= 0; i--) {
          const message = page[i] as HarnessUIMessage
          if (!isBoundary(message, registry)) continue
          const payload = (message.parts[0] as { data?: CompactionPayload } | undefined)?.data
          out.compaction = { markerId: message.id, resumeFromId: payload?.resumeFromId ?? null }
          break
        }
      }
      if (raw.length < FORK_PAGE_SIZE || page.length < raw.length) break
      cursor = (page[0] as HarnessUIMessage).id
    }
  } catch (error) {
    if (isHarnessError(error)) throw error
    throw new HarnessError('EH_STORAGE', 'Message storage failed (fork).', { cause: error })
  }
  return out
}
