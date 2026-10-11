import { describe, expect, test } from 'bun:test'
import { openDatabase } from '../src/infra/db/client.ts'
import { pruneTables } from '../src/infra/db/retention.ts'

describe('pruneTables', () => {
  test('drops old finished rows, keeps recent and running ones', () => {
    const { sqlite } = openDatabase(':memory:')
    const now = 1_000_000_000_000
    const day = 86_400_000
    const task = (id: string, state: string, endedAt: number | null) =>
      sqlite
        .query(
          `INSERT INTO tasks (id, agent_id, session_id, origin, title, state, started_at, ended_at, last_activity_at)
           VALUES (?, 'a', ?, 'chat', 't', ?, 0, ?, 0)`,
        )
        .run(id, `s-${id}`, state, endedAt)
    task('old', 'done', now - 100 * day)
    task('new', 'done', now - day)
    task('run', 'running', null)
    const run = (id: string, status: string, at: number) =>
      sqlite
        .query(
          `INSERT INTO routine_runs (id, routine_id, scheduled_at, trigger, status, session_id, claimed_at, finished_at)
           VALUES (?, 'r', ?, 'schedule', ?, 's', ?, ?)`,
        )
        .run(id, at, status, at, at)
    run('r-old', 'succeeded', now - 40 * day)
    run('r-new', 'succeeded', now - day)
    run('r-live', 'claimed', now - 41 * day)
    const out = pruneTables(sqlite, {}, now)
    expect(out.tasks).toBe(1)
    expect(out.routineRuns).toBe(1)
    const ids = sqlite
      .query<{ id: string }, []>('SELECT id FROM tasks')
      .all()
      .map((r) => r.id)
    expect(ids.sort()).toEqual(['new', 'run'])
  })
})
