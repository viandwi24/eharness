/** Programs on SQLite (drizzle, like the agents). A schedule trigger is owned by one routine row. */
import { desc, eq, sql } from 'drizzle-orm'
import type { NewProgram, ProgramPatch, ProgramStore } from '../../app/ports.ts'
import { parseDeliverables } from '../../domain/deliverables.ts'
import type { Program, ProgramReportMode, ProgramStatus } from '../../domain/programs.ts'
import type { RoutineSpec } from '../../domain/routines.ts'
import type { Db } from './client.ts'
import { programs } from './schema.ts'

type Row = typeof programs.$inferSelect

const toProgram = (row: Row): Program => ({
  id: row.id,
  agentId: row.agentId,
  name: row.name,
  brief: row.brief,
  authority: row.authority,
  gates: row.gates,
  escalation: row.escalation,
  forbidden: row.forbidden,
  budget: row.budget,
  trigger:
    row.trigger.kind === 'schedule'
      ? { kind: 'schedule', spec: row.trigger.spec as unknown as RoutineSpec }
      : { kind: 'manual' },
  report: row.report as ProgramReportMode,
  worker: row.worker,
  deliverables: parseDeliverables(row.deliverables),
  status: row.status as ProgramStatus,
  createdBy: row.createdBy,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  version: row.version,
})

export function drizzleProgramStore(db: Db): ProgramStore {
  const get = (id: string): Program | undefined => {
    const row = db.select().from(programs).where(eq(programs.id, id)).get()
    return row === undefined ? undefined : toProgram(row)
  }
  return {
    list({ agentId }) {
      const rows =
        agentId === undefined
          ? db.select().from(programs).orderBy(desc(programs.createdAt), programs.id).all()
          : db
              .select()
              .from(programs)
              .where(eq(programs.agentId, agentId))
              .orderBy(desc(programs.createdAt), programs.id)
              .all()
      return rows.map(toProgram)
    },

    get,

    insert(p: NewProgram) {
      const { now, ...rest } = p
      db.insert(programs)
        .values({
          ...rest,
          trigger:
            rest.trigger.kind === 'schedule'
              ? { kind: 'schedule', spec: rest.trigger.spec as unknown as Record<string, unknown> }
              : { kind: 'manual' },
          createdAt: now,
          updatedAt: now,
          version: 1,
        })
        .run()
      return get(p.id) as Program
    },

    update(id, patch: ProgramPatch, now) {
      const { trigger, ...rest } = patch
      const rows = db
        .update(programs)
        .set({
          ...rest,
          ...(trigger === undefined
            ? {}
            : {
                trigger:
                  trigger.kind === 'schedule'
                    ? { kind: 'schedule', spec: trigger.spec as unknown as Record<string, unknown> }
                    : { kind: 'manual' },
              }),
          updatedAt: now,
          version: sql`${programs.version} + 1`,
        })
        .where(eq(programs.id, id))
        .returning({ id: programs.id })
        .all()
      return rows.length === 0 ? undefined : get(id)
    },

    delete(id) {
      return (
        db.delete(programs).where(eq(programs.id, id)).returning({ id: programs.id }).all().length >
        0
      )
    },
  }
}
