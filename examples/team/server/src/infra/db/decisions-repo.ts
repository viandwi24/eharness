/** Decisions on SQLite (drizzle). Deciding is a compare-and-set on `status = 'open'`: the first answer wins. */
import { and, count, desc, eq } from 'drizzle-orm'
import type { DecisionPatch, DecisionStore, NewDecision } from '../../app/ports.ts'
import type { Decision, DecisionKind, DecisionStatus } from '../../domain/decisions.ts'
import type { Db } from './client.ts'
import { decisions } from './schema.ts'

type Row = typeof decisions.$inferSelect

const toDecision = (row: Row): Decision =>
  ({
    id: row.id,
    kind: row.kind as DecisionKind,
    status: row.status as DecisionStatus,
    title: row.title,
    body: row.body,
    agentId: row.agentId,
    sessionId: row.sessionId,
    programId: row.programId,
    payload: row.payload,
    waitId: row.waitId,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
    decisionNote: row.decisionNote,
    outcome: row.outcome as Decision['outcome'],
    createdAt: row.createdAt,
  }) as unknown as Decision

export function drizzleDecisionStore(db: Db): DecisionStore {
  const get = (id: string): Decision | undefined => {
    const row = db.select().from(decisions).where(eq(decisions.id, id)).get()
    return row === undefined ? undefined : toDecision(row)
  }
  return {
    get,

    getByWait(waitId) {
      const row = db.select().from(decisions).where(eq(decisions.waitId, waitId)).get()
      return row === undefined ? undefined : toDecision(row)
    },

    list({ status, kind, agentId, sessionId, limit }) {
      const where = and(
        status === undefined ? undefined : eq(decisions.status, status),
        kind === undefined ? undefined : eq(decisions.kind, kind),
        agentId === undefined ? undefined : eq(decisions.agentId, agentId),
        sessionId === undefined ? undefined : eq(decisions.sessionId, sessionId),
      )
      return db
        .select()
        .from(decisions)
        .where(where)
        .orderBy(desc(decisions.createdAt), desc(decisions.id))
        .limit(limit)
        .all()
        .map(toDecision)
    },

    countOpen() {
      return (
        db.select({ n: count() }).from(decisions).where(eq(decisions.status, 'open')).get()?.n ?? 0
      )
    },

    insert(d: NewDecision) {
      db.insert(decisions)
        .values({
          id: d.id,
          kind: d.kind,
          status: 'open',
          title: d.title,
          body: d.body,
          agentId: d.agentId,
          sessionId: d.sessionId,
          programId: d.programId,
          payload: d.payload as unknown as Record<string, unknown>,
          waitId: d.waitId,
          createdAt: d.createdAt,
        })
        .run()
      return get(d.id) as Decision
    },

    decide(id, patch: DecisionPatch) {
      const rows = db
        .update(decisions)
        .set({
          status: patch.status,
          decidedBy: patch.decidedBy,
          decidedAt: patch.decidedAt,
          decisionNote: patch.note,
          ...(patch.outcome === undefined
            ? {}
            : { outcome: patch.outcome as unknown as Record<string, unknown> }),
          ...(patch.payload === undefined
            ? {}
            : { payload: patch.payload as unknown as Record<string, unknown> }),
          ...(patch.programId === undefined ? {} : { programId: patch.programId }),
        })
        .where(and(eq(decisions.id, id), eq(decisions.status, 'open')))
        .returning({ id: decisions.id })
        .all()
      return rows.length === 0 ? undefined : get(id)
    },

    reopen(id) {
      db.update(decisions)
        .set({
          status: 'open',
          decidedBy: null,
          decidedAt: null,
          decisionNote: null,
          outcome: null,
        })
        .where(eq(decisions.id, id))
        .run()
      return get(id)
    },

    setOutcome(id, outcome, programId) {
      db.update(decisions)
        .set({
          outcome: outcome as unknown as Record<string, unknown>,
          ...(programId === undefined ? {} : { programId }),
        })
        .where(eq(decisions.id, id))
        .run()
      return get(id)
    },
  }
}
