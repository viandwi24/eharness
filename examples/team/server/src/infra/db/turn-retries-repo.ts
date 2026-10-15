/**
 * Failed turns waiting for their automatic retry (`turn_retries`, one row per session). Plain SQL
 * on the shared connection; every state change is one statement or a compare-and-set, so several
 * instances never run the same retry.
 */
import type { Database } from 'bun:sqlite'
import type { PendingRetry } from '../../domain/turn-retry.ts'

export type RetryState = 'pending' | 'running' | 'failed'

export interface RetryRow {
  sessionId: string
  agentId: string
  turnId: string
  attempt: number
  maxAttempts: number
  nextAt: number
  errorCode: string
  errorMessage: string
  state: RetryState
  claimedUntil: number | null
  createdAt: number
  updatedAt: number
}

interface Raw {
  session_id: string
  agent_id: string
  turn_id: string
  attempt: number
  max_attempts: number
  next_at: number
  error_code: string
  error_message: string
  state: string
  claimed_until: number | null
  created_at: number
  updated_at: number
}

const toRow = (r: Raw): RetryRow => ({
  sessionId: r.session_id,
  agentId: r.agent_id,
  turnId: r.turn_id,
  attempt: r.attempt,
  maxAttempts: r.max_attempts,
  nextAt: r.next_at,
  errorCode: r.error_code,
  errorMessage: r.error_message,
  state: r.state as RetryState,
  claimedUntil: r.claimed_until,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

/** The view the task, the run and the Health page use (a `failed` row waits for nothing). */
export const toPending = (r: RetryRow): PendingRetry | undefined =>
  r.state === 'failed'
    ? undefined
    : {
        sessionId: r.sessionId,
        attempt: r.attempt,
        max: r.maxAttempts,
        nextAt: r.nextAt,
        errorCode: r.errorCode,
        errorMessage: r.errorMessage,
        running: r.state === 'running',
      }

export interface TurnRetryStore {
  get(sessionId: string): RetryRow | undefined
  /** Rows that wait or run (`failed` rows excluded). */
  waiting(): RetryRow[]
  put(row: Omit<RetryRow, 'createdAt' | 'updatedAt' | 'claimedUntil'>, now: number): RetryRow
  delete(sessionId: string): boolean
  /** Take the pending rows that are due (compare-and-set to `running`, with a lease). */
  claimDue(now: number, leaseMs: number, limit: number): RetryRow[]
}

export function sqliteTurnRetryStore(sqlite: Database): TurnRetryStore {
  const one = sqlite.query<Raw, [string]>('SELECT * FROM turn_retries WHERE session_id = ?')
  return {
    get(sessionId) {
      const r = one.get(sessionId)
      return r === null ? undefined : toRow(r)
    },
    waiting() {
      return sqlite
        .query<Raw, []>("SELECT * FROM turn_retries WHERE state IN ('pending', 'running')")
        .all()
        .map(toRow)
    },
    put(row, now) {
      sqlite
        .query(
          `INSERT INTO turn_retries (session_id, agent_id, turn_id, attempt, max_attempts, next_at,
                                     error_code, error_message, state, claimed_until, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             agent_id = excluded.agent_id, turn_id = excluded.turn_id, attempt = excluded.attempt,
             max_attempts = excluded.max_attempts, next_at = excluded.next_at,
             error_code = excluded.error_code, error_message = excluded.error_message,
             state = excluded.state, claimed_until = NULL, updated_at = excluded.updated_at`,
        )
        .run(
          row.sessionId,
          row.agentId,
          row.turnId,
          row.attempt,
          row.maxAttempts,
          row.nextAt,
          row.errorCode,
          row.errorMessage,
          row.state,
          now,
          now,
        )
      return toRow(one.get(row.sessionId) as Raw)
    },
    delete(sessionId) {
      return (
        sqlite.query('DELETE FROM turn_retries WHERE session_id = ?').run(sessionId).changes > 0
      )
    },
    claimDue(now, leaseMs, limit) {
      const due = sqlite
        .query<Raw, [number, number]>(
          "SELECT * FROM turn_retries WHERE state = 'pending' AND next_at <= ? ORDER BY next_at LIMIT ?",
        )
        .all(now, limit)
      const claimed: RetryRow[] = []
      for (const r of due) {
        const res = sqlite
          .query(
            `UPDATE turn_retries SET state = 'running', claimed_until = ?, updated_at = ?
              WHERE session_id = ? AND state = 'pending' AND turn_id = ?`,
          )
          .run(now + leaseMs, now, r.session_id, r.turn_id)
        if (res.changes > 0) claimed.push(toRow({ ...r, state: 'running' }))
      }
      return claimed
    },
  }
}
