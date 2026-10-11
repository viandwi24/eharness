/**
 * The invariants of the soak test, checked on the SQLite file after the server stopped and the
 * work drained. Pure reads: `checkInvariants(dbFile, context)` returns the violations (empty =
 * the state is consistent). The same checker runs in the unit test with deliberately broken rows.
 */
import { Database } from 'bun:sqlite'

export interface SoakContext {
  /** Ids of the tasks the driver queued (none may be lost). */
  queuedIds: string[]
  /** How many times the driver sent each task back (round = 1 + this). */
  sentBack: Record<string, number>
  /** Id of the lead agent (its DM holds the digest). */
  leadId: string
}

export interface Violation {
  invariant: string
  detail: string
}

const FINAL = ['done', 'failed', 'stopped', 'interrupted', 'timed_out']

type Row = Record<string, unknown>
const all = (db: Database, sql: string, ...args: Array<string | number>): Row[] =>
  db.query(sql).all(...args) as Row[]

export function checkInvariants(dbFile: string, ctx: SoakContext): Violation[] {
  const db = new Database(dbFile, { readonly: true })
  const out: Violation[] = []
  const bad = (invariant: string, detail: string): void => {
    out.push({ invariant, detail })
  }
  try {
    const tasks = all(db, 'SELECT * FROM tasks')
    const byId = new Map(tasks.map((t) => [t.id as string, t]))
    const bySession = new Map(tasks.map((t) => [t.session_id as string, t]))
    // the sessions of earlier rounds: a task sent back keeps its first run only in `history`
    const earlier = new Set(tasks.flatMap((t) => JSON.parse(String(t.history ?? '[]')) as string[]))

    // 1. no task stuck: after the drain nothing runs, waits or is queued
    for (const t of tasks) {
      if (!FINAL.includes(t.state as string)) {
        bad('no-stuck-task', `${t.id} (${t.session_id}) is ${t.state} at the end`)
      }
      if (t.state === 'done' && t.ended_at === null)
        bad('no-stuck-task', `${t.id} done without ended_at`)
    }

    // 2. queued work: nothing lost, nothing claimed twice
    for (const id of ctx.queuedIds) {
      const t = byId.get(id)
      if (t === undefined) {
        bad('queue-lost', `queued task ${id} has no row`)
        continue
      }
      const round = Number(t.round)
      const history = JSON.parse(String(t.history ?? '[]')) as string[]
      const expected = 1 + (ctx.sentBack[id] ?? 0)
      if (round !== expected) bad('queue-twice', `${id}: round ${round}, expected ${expected}`)
      if (history.length !== round - 1) {
        bad('queue-twice', `${id}: history ${history.length} entries for round ${round}`)
      }
      if (new Set(history).size !== history.length) bad('queue-twice', `${id}: duplicate history`)
      if (history.includes(String(t.session_id)))
        bad('queue-twice', `${id}: session also in history`)
    }
    // one session = one task, one run = one session
    const sessions = all(
      db,
      'SELECT session_id, COUNT(*) AS n FROM tasks GROUP BY session_id HAVING n > 1',
    )
    for (const s of sessions)
      bad('queue-twice', `session ${s.session_id} is the session of ${s.n} tasks`)
    // a worker run claims at most `maxTasks`; a session id is never reused by another task's history
    const used = new Map<string, string>()
    for (const t of tasks) {
      for (const h of JSON.parse(String(t.history ?? '[]')) as string[]) {
        const owner = used.get(h)
        if (owner !== undefined && owner !== t.id)
          bad('queue-twice', `session ${h} is in the history of ${owner} and ${t.id}`)
        used.set(h, t.id as string)
        if (bySession.has(h))
          bad(
            'queue-twice',
            `history session ${h} is also the live session of ${bySession.get(h)?.id}`,
          )
      }
    }

    // 3. every program run has a task row with a final status
    const runs = all(
      db,
      'SELECT r.*, ro.program_id AS program_id FROM routine_runs r JOIN routines ro ON ro.id = r.routine_id',
    )
    for (const r of runs) {
      const status = r.status as string
      const owned = typeof r.program_id === 'string' && !(r.program_id as string).startsWith('sys:')
      if (!['succeeded', 'failed', 'skipped'].includes(status)) {
        bad('run-has-task', `routine run ${r.id} (${r.session_id}) is ${status} at the end`)
        continue
      }
      if (owned && status !== 'skipped') {
        const t = bySession.get(r.session_id as string)
        if (t === undefined && earlier.has(r.session_id as string)) continue
        if (t === undefined)
          bad('run-has-task', `routine run ${r.id} (${status}) has no task for ${r.session_id}`)
        else if (!FINAL.includes(t.state as string))
          bad('run-has-task', `task of run ${r.id} is ${t.state}`)
        else if (status === 'succeeded' && t.state !== 'done') {
          bad('run-has-task', `routine run ${r.id} succeeded but its task is ${t.state}`)
        }
      }
    }
    for (const t of tasks) {
      if (t.origin === 'program' && !FINAL.includes(t.state as string)) {
        bad('run-has-task', `program task ${t.id} is ${t.state}`)
      }
      if (t.origin === 'program' && t.state === 'done' && t.report === null) {
        bad('run-has-task', `program task ${t.id} is done without a report`)
      }
    }

    // 4. decisions consistent: none open, every decided one has its decision, no session still parked
    for (const d of all(db, 'SELECT * FROM decisions')) {
      if (d.status === 'open')
        bad('decisions', `decision ${d.id} (${d.kind}) is still open at the end`)
      else if (d.decided_at === null)
        bad('decisions', `decision ${d.id} is ${d.status} without decided_at`)
      if (d.kind !== 'proposal' && d.wait_id === null)
        bad('decisions', `${d.kind} ${d.id} has no wait id`)
    }
    for (const s of all(
      db,
      "SELECT session_id, state FROM eh_state WHERE session_id NOT LIKE 'dm:%'",
    )) {
      const core = (
        JSON.parse(String(s.state)) as { core?: { pending?: unknown; activeTurn?: unknown } }
      ).core
      // every decision is settled, so no session may still wait for one or hold a live turn
      if (core?.pending !== undefined) {
        bad('decisions', `session ${s.session_id} still waits (pending) but no decision is open`)
      }
      if (core?.activeTurn !== undefined) {
        bad('no-stuck-task', `session ${s.session_id} still has an active turn at the end`)
      }
    }

    // 5. budget: the workspace ledger equals the sum of the calls that were paid
    const ledger = all(db, "SELECT spent_usd FROM eh_budget_scope WHERE scope LIKE 'workspace:%'")
    const spent = ledger.reduce((sum, r) => sum + Number(r.spent_usd), 0)
    const calls = all(
      db,
      "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM model_calls WHERE kind = 'step'",
    )
    const total = Number(calls[0]?.total ?? 0)
    if (Math.abs(spent - total) > 1e-6) {
      bad('budget', `workspace ledger ${spent} differs from the sum of model calls ${total}`)
    }
    // a reservation of a killed process stays open until it expires (10 minutes): that is the
    // design; one still open past its expiry is a leak
    const open = all(
      db,
      "SELECT COUNT(*) AS n FROM eh_budget_reservation WHERE state = 'open' AND expires_at < ?",
      Date.now(),
    )
    if (Number(open[0]?.n ?? 0) > 0) {
      bad('budget', `${open[0]?.n} expired budget reservations are still open`)
    }

    // 6. at most one digest per local day
    const digests = all(
      db,
      "SELECT parts FROM eh_messages WHERE session_id = ? AND parts LIKE '%daily-digest%'",
      `dm:${ctx.leadId}`,
    )
    const keys = new Set<string>()
    for (const row of digests) {
      for (const part of JSON.parse(String(row.parts)) as Array<{
        type?: string
        data?: { name?: string; text?: string }
      }>) {
        if (part.type === 'data-eh.event' && part.data?.name === 'daily-digest') {
          const text = part.data.text ?? ''
          if (keys.has(text)) bad('digest-once', 'the same digest text is stored twice')
          keys.add(text)
        }
      }
    }
    const perDay = new Map<string, number>()
    for (const row of all(
      db,
      "SELECT created_at FROM eh_messages WHERE session_id = ? AND parts LIKE '%daily-digest%'",
      `dm:${ctx.leadId}`,
    )) {
      const day = new Date(Number(row.created_at)).toISOString().slice(0, 10)
      perDay.set(day, (perDay.get(day) ?? 0) + 1)
    }
    for (const [day, n] of perDay) if (n > 1) bad('digest-once', `${n} digests on ${day}`)

    // 7. heartbeat history
    for (const row of all(
      db,
      "SELECT key, value FROM settings WHERE key LIKE 'heartbeat:%:state'",
    )) {
      const state = JSON.parse(String(row.value)) as { beats: Array<Row> }
      const seen = new Set<string>()
      for (const b of state.beats) {
        const id = String(b.id)
        if (b.status === 'skipped') {
          if (typeof b.reason !== 'string')
            bad('heartbeat', `${row.key}: skipped beat ${id} has no reason`)
          continue
        }
        if (seen.has(id)) bad('heartbeat', `${row.key}: beat ${id} twice`)
        seen.add(id)
        if (b.status === 'running')
          bad('heartbeat', `${row.key}: beat ${id} still running at the end`)
        if (b.endedAt === null || Number(b.endedAt) < Number(b.at))
          bad('heartbeat', `${row.key}: beat ${id} ends before it starts`)
        if (b.status === 'attention' && (b.items as unknown[]).length === 0)
          bad('heartbeat', `${row.key}: attention beat ${id} without items`)
        if (b.status === 'ok' && (b.items as unknown[]).length > 0)
          bad('heartbeat', `${row.key}: ok beat ${id} with items`)
      }
    }

    // 8. no orphans: every run session has its task, every task its program, nothing left in the inbox
    const programs = new Set(all(db, 'SELECT id FROM programs').map((p) => p.id as string))
    for (const s of all(db, "SELECT session_id FROM eh_state WHERE session_id LIKE 'program:%'")) {
      if (!bySession.has(s.session_id as string)) {
        const inHistory = tasks.some((t) =>
          (JSON.parse(String(t.history ?? '[]')) as string[]).includes(s.session_id as string),
        )
        if (!inHistory) bad('orphans', `session ${s.session_id} has no task`)
      }
      const parts = String(s.session_id).split(':')
      if (!programs.has(parts[1] as string))
        bad('orphans', `session ${s.session_id} names a missing program`)
    }
    for (const t of tasks) {
      if (typeof t.parent_session_id === 'string') {
        const has =
          all(db, 'SELECT 1 FROM eh_state WHERE session_id = ?', t.parent_session_id as string)
            .length > 0
        if (!has) bad('orphans', `task ${t.id} has a missing parent session ${t.parent_session_id}`)
      }
    }
    const stuck = all(
      db,
      "SELECT session_id, kind FROM eh_inbox WHERE dead_at IS NULL AND (session_id LIKE 'program:%' OR session_id LIKE 'heartbeat:%')",
    )
    for (const i of stuck)
      bad('orphans', `inbox item (${i.kind}) of ${i.session_id} was never delivered`)
  } finally {
    db.close()
  }
  return out
}

export function formatViolations(violations: Violation[]): string {
  return violations.map((v) => `[${v.invariant}] ${v.detail}`).join('\n')
}
