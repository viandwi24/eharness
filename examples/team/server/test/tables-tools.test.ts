/**
 * The agent tools over tables (P59 W2): `tables_write` and `tables_read` through real turns, the
 * readable answers, drop only with confirm, errors as `ERROR:` lines, a chat member refused, and
 * the activity feed entries.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import {
  CHAT,
  chat,
  connectMock,
  type Rig,
  rig,
  toolCall,
  toolResults,
  until,
} from './support/agent-rig.ts'

const rigs: Rig[] = []
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.close()
})

describe('tables tools', () => {
  test('the owner asks in the web chat: create, insert, query, aggregate, drop with confirm', async () => {
    const r = rig({
      lead: [
        toolCall('tables_write', {
          action: 'create',
          table: 'joiners',
          description: 'People who asked to join',
          columns: [
            { name: 'name', type: 'string', required: true },
            { name: 'chat', type: 'string', indexed: true },
            { name: 'approved', type: 'boolean', default: false },
          ],
        }),
        toolCall('tables_write', {
          action: 'insert',
          table: 'joiners',
          rows: [
            { name: 'Zed', chat: 'Ops' },
            { name: 'Ana', chat: 'Ops', approved: true },
            { name: 'Budi', chat: 'VIP' },
          ],
        }),
        toolCall('tables_read', {
          action: 'query',
          table: 'joiners',
          filter: { chat: 'Ops' },
          sort: { name: 1 },
          fields: ['name', 'approved'],
        }),
        toolCall('tables_read', {
          action: 'aggregate',
          table: 'joiners',
          groupBy: ['chat'],
          metrics: { n: { op: 'count' } },
        }),
        toolCall('tables_read', { action: 'query', table: 'joiners', filter: { "x') OR 1=1": 1 } }),
        toolCall('tables_write', { action: 'drop', table: 'joiners' }),
        toolCall('tables_read', { action: 'list' }),
        { text: 'done' },
      ],
    })
    rigs.push(r)
    await chat(r, 'lead', 'keep a table of joiners')
    const out = toolResults(r.models.lead)
    expect(out[0]).toContain('Created.\nTable joiners (0 rows')
    expect(out[0]).toContain('- chat: string, indexed')
    expect(out[1]).toMatch(/^Inserted 3 row\(s\)/)
    expect(out[2]).toContain('2 row(s) match; showing 2')
    expect(out[2]).toContain('{"name":"Ana","approved":true}')
    expect(out[2]).toContain('{"name":"Zed","approved":false}')
    expect(out[3]).toContain('{"chat":"Ops","n":2}')
    expect(out[4]).toMatch(/^ERROR: .*is not a field/)
    expect(out[5]).toContain('ERROR: dropping removes the table')
    expect(out[6]).toContain('- joiners: 3 rows')
    // rows written by the agent carry its name; the feed has the changes
    const page = await r.api('POST', '/tables/joiners/query', { limit: 1 })
    expect((page.json.rows as Array<{ createdBy: string }>)[0]?.createdBy).toBe('Lead')
    const feed = r.server.conn.sqlite
      .query<{ payload: string }, []>(
        "SELECT payload FROM events WHERE type = 'tables-changed' ORDER BY seq",
      )
      .all()
      .map((e) => JSON.parse(e.payload) as { change: string; count?: number; by: string })
    expect(feed.map((e) => e.change)).toEqual(['created', 'row.created'])
    expect(feed[1]).toMatchObject({ count: 3, by: 'Lead' })
  })

  test('a member in a chat is refused with a sentence, and nothing changes', async () => {
    const r = rig({
      lead: [toolCall('tables_write', { action: 'create', table: 'secret' }), { text: 'sorry' }],
    })
    rigs.push(r)
    const mock = await connectMock(r)
    r.server.channels.people.setRole('c1', '55', { role: 'member' }, 'owner')
    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: { id: '55', name: 'Zed', username: 'zed' },
      text: 'make a table',
      mentionSelf: true,
    })
    await until('answered', () => (r.models.lead?.prompts.length ?? 0) >= 2)
    expect(toolResults(r.models.lead).join('\n')).toContain('Not allowed')
    expect((await r.api('GET', '/tables')).json.tables).toEqual([])
  })
})
