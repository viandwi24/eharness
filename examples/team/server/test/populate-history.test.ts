/** Smoke test of `populateHistory`: every history table ends up with rows. */
import { afterEach, expect, test } from 'bun:test'
import { cleanup, instance, populateBase } from './support/backup-world.ts'
import { populateHistory } from './support/populate-history.ts'

afterEach(cleanup)

const TABLES = [
  'decisions',
  'tasks',
  'alarms',
  'notifications',
  'agent_persona_proposals',
  'program_tests',
  'rehearsals',
  'chats',
  'chat_threads',
  'session_modes',
  'chat_tool_overrides',
  'eh_state',
  'eh_messages',
]

test('populateHistory fills every history table', async () => {
  const { server } = instance()
  const base = await populateBase(server)
  const world = await populateHistory(server, base)
  const count = (table: string): number =>
    server.conn.sqlite.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0
  for (const table of TABLES) expect(count(table), table).toBeGreaterThan(0)
  expect(count('decisions')).toBeGreaterThanOrEqual(4)
  expect(count('tasks')).toBeGreaterThanOrEqual(3)
  expect(count('agent_persona_proposals')).toBeGreaterThanOrEqual(3)
  const keys = server.conn.sqlite
    .query<{ key: string }, []>('SELECT key FROM settings')
    .all()
    .map((r) => r.key)
  for (const key of world.settingKeys) expect(keys).toContain(key)
  expect(world.queuedTaskId).not.toBe('')
})
