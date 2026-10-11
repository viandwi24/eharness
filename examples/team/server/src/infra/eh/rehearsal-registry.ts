/**
 * The rehearsals running in this process (docs/plans/P40-team-autonomous-operations.md, phase K).
 *
 * Plugins and the agent factory are built once per agent, not per session, so they find the
 * overlay file system, the recorder and the budget of a rehearsal session here, by session id.
 * The registry is module-level on purpose: it keeps the factory, the connector catalog and the
 * big-data hook free of one more constructor parameter, and session ids are unique
 * (`rehearsal:<programId>:<ts>`), so servers in one process never meet each other's entries.
 *
 * Fail closed: a session id that looks like a rehearsal but is not registered (the process
 * restarted, the rehearsal ended) gets a read-only view of the library, never the real one.
 */
import type { FileSystem } from 'eharness/filesystem'
import { isRehearsalSession, type SimulatedAction, type WouldAsk } from '../../domain/rehearsal.ts'
import { type OverlayFs, readOnlyFs } from './overlay-fs.ts'

/** What the tools and the gate report to the rehearsal that is running. */
export interface RehearsalRecorder {
  simulated(action: Omit<SimulatedAction, 'at'>): void
  wouldAsk(entry: Omit<WouldAsk, 'at'>): void
}

export interface RehearsalSession {
  rehearsalId: string
  sessionId: string
  programId: string
  /** The overlay every file tool of the session sees. */
  fs: OverlayFs
  /** Spend cap of the rehearsal (USD): a ledger scope of its own. */
  budgetUsd: number
  /** A worker program: `complete_task` is offered (and simulated). */
  worker: boolean
  recorder: RehearsalRecorder
}

const sessions = new Map<string, RehearsalSession>()

export const rehearsalSessions = {
  get: (sessionId: string): RehearsalSession | undefined => sessions.get(sessionId),
  register(session: RehearsalSession): void {
    sessions.set(session.sessionId, session)
  },
  release(sessionId: string): void {
    sessions.delete(sessionId)
  },
  /** Running rehearsals of this process. */
  count: (): number => sessions.size,
}

/**
 * The `fs` of the file tools and the memory plugin: the overlay of a rehearsal session, a
 * read-only view for a rehearsal session that is not running, the library itself for any other.
 */
export function sessionFileSystem(
  base: FileSystem,
): (ctx: { session: { id: string } }) => FileSystem {
  return (ctx) => fileSystemOfSession(ctx.session.id, base)
}

export function fileSystemOfSession(sessionId: string, base: FileSystem): FileSystem {
  const running = sessions.get(sessionId)
  if (running !== undefined) return running.fs
  return isRehearsalSession(sessionId) ? readOnlyFs(base) : base
}
