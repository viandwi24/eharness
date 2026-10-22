import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, instance, populateBase } from './support/backup-world.ts'
import { populateChannels } from './support/populate-channels.ts'

afterEach(cleanup)

const TABLES = [
  'channel_connections',
  'tgu_settings',
  'tgu_chats',
  'ch_nodes',
  'ch_node_links',
  'ch_node_access',
  'ch_node_settings',
  'ch_identities',
  'ch_identity_aliases',
  'ch_identity_profiles',
  'ch_memberships',
  'ch_node_sessions',
  'ch_people',
  'ch_people_notes',
  'ch_proactive',
  'ch_reminders',
  'people_accounts',
  'people_events',
]

describe('populateChannels', () => {
  test('every channels, people and reminders table has rows', async () => {
    const { server } = instance()
    const base = await populateBase(server)
    const world = await populateChannels(server, base)
    const count = (sql: string): number =>
      (server.conn.sqlite.query<{ n: number }, []>(sql).get() as { n: number }).n
    for (const t of TABLES) expect(count(`SELECT COUNT(*) AS n FROM ${t}`)).toBeGreaterThan(0)
    expect(
      count("SELECT COUNT(*) AS n FROM routines WHERE program_id LIKE 'sys:reminder:%'"),
    ).toBeGreaterThan(0)
    expect(count("SELECT COUNT(*) AS n FROM ch_reminders WHERE status = 'active'")).toBeGreaterThan(
      0,
    )
    expect(count("SELECT COUNT(*) AS n FROM ch_reminders WHERE status = 'done'")).toBeGreaterThan(0)
    expect(count("SELECT COUNT(*) AS n FROM ch_proactive WHERE status = 'held'")).toBeGreaterThan(0)
    expect(world.mock.sent.length).toBeGreaterThan(0)
  })
})
