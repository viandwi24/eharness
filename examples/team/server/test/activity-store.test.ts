/**
 * The team's SQLite `ActivityStore` passes the library's conformance suite (two connections to one
 * file model two instances), and the event vocabulary mirrors `eharness/activity`.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SESSION_ACTIVITY_TYPES } from 'eharness/activity'
import { activityStoreConformance } from 'eharness/testing'
import { EVENT_TYPES, SESSION_EVENT_TYPES } from '../src/domain/events.ts'
import { sqliteActivityStore } from '../src/infra/db/activity-store.ts'
import { openDatabase } from '../src/infra/db/client.ts'

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('sqliteActivityStore conformance', () => {
  for (const c of activityStoreConformance(() => {
    const dir = mkdtempSync(join(tmpdir(), 'team-activity-'))
    dirs.push(dir)
    const file = join(dir, 'team.db')
    const first = openDatabase(file)
    const second = openDatabase(file)
    return {
      store: sqliteActivityStore(first.sqlite),
      peer: () => sqliteActivityStore(second.sqlite),
    }
  })) {
    test(c.name, c.run)
  }
})

test('the session events this app enables are events of the library, and all are known to the feed', () => {
  for (const type of SESSION_EVENT_TYPES) {
    expect(SESSION_ACTIVITY_TYPES).toContain(type)
    expect(EVENT_TYPES).toContain(type)
  }
})
