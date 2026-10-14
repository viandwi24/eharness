/** The library's schedule store conformance suite against the SQLite store over `routines`. */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createScheduler } from 'eharness/scheduler'
import { scheduleStoreConformance } from 'eharness/testing'
import { openDatabase } from '../src/infra/db/client.ts'
import { sqliteRoutineStore } from '../src/infra/db/routines-repo.ts'
import { sqliteScheduleStore } from '../src/infra/eh/schedule-store.ts'

const dir = mkdtempSync(join(tmpdir(), 'team-schedule-store-'))
const conn = openDatabase(join(dir, 'team.db'))
afterAll(() => {
  conn.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('ScheduleStore conformance (SQLite, routines table)', () => {
  for (const c of scheduleStoreConformance(() => sqliteScheduleStore(conn.sqlite))) {
    test(c.name, c.run)
  }
})

describe('ScheduleStore over a real routine row', () => {
  test('a routine row is a schedule: a tick fires it and the app columns survive', async () => {
    const own = openDatabase(join(dir, 'real.db'))
    const routines = sqliteRoutineStore(own.sqlite)
    routines.insert({
      id: 'r-real',
      agentId: 'ag',
      name: 'Briefing',
      prompt: 'Brief me.',
      schedule: { kind: 'every', everyMs: 60_000 },
      sessionMode: 'task',
      overlap: 'skip',
      catchUpWindowMs: null,
      maxFailures: 3,
      maxFires: null,
      endAt: null,
      nextFireAt: 1000,
      now: 1,
    })
    const store = sqliteScheduleStore(own.sqlite)
    const fired: string[] = []
    const scheduler = createScheduler({
      store,
      now: () => 1500,
      fire: ({ fireId }) => {
        fired.push(fireId)
      },
    })
    const report = await scheduler.tick()
    expect(fired).toEqual(['sched:r-real:1000'])
    expect(report.fired).toHaveLength(1)
    const row = routines.get('r-real')
    expect(row).toMatchObject({
      name: 'Briefing',
      prompt: 'Brief me.',
      version: 1, // editors' token untouched by a tick
      status: 'active',
      nextFireAt: 61_000,
    })
    own.close()
  })
})
