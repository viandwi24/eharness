/**
 * The server-side tables behind the Channels pages (chats, people, inbox, activity, reminders):
 * filter, search, sort and the exact total are done in SQL and only the page is turned into views.
 * Gateway level, on a mock adapter and scripted models (no model call is made).
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webCryptoVault } from 'eharness/providers'
import { scriptedModel } from 'eharness/testing'
import { updateAgent } from '../src/app/agents.ts'
import { type ChannelGateway, createMockAdapter } from '../src/infra/channels/index.ts'
import type { ModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'

const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

interface Instance {
  server: Server
  gw: ChannelGateway
  leadId: string
}

function instance(): Instance {
  const dir = mkdtempSync(join(tmpdir(), 'team-tables-'))
  dirs.push(dir)
  const config: ModelConfig = {
    provider: 'scripted',
    defaultModel: 'none',
    resolve: () =>
      scriptedModel([
        () => {
          throw new Error('unexpected model call')
        },
      ]),
  }
  const server = compose({
    dbFile: join(dir, 'team.db'),
    instanceId: 'tables-test',
    models: config,
    env: {},
    tuning: { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 },
    eventsPollMs: 30,
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
    channels: {
      vault: webCryptoVault(new Uint8Array(32).fill(9)),
      collect: { quietMs: 25, maxWaitMs: 300, maxItems: 20 },
      typingEveryMs: 20,
      purgeEveryMs: 0,
      maintenanceMs: 0,
    },
  })
  servers.push(server)
  const def = server.deps.agents.getBySlug('lead')
  if (def === undefined) throw new Error('seed missing')
  updateAgent(server.deps, def.id, { model: 'm-lead' })
  return { server, gw: server.channels, leadId: def.id }
}

const page = (n = 1, limit = 25) => ({ page: n, limit })

describe('chats table', () => {
  function seeded() {
    const i = instance()
    i.gw.configure({ connectionId: 'c1', agentId: i.leadId, groupPolicy: 'allowlist' })
    const ids: Record<string, string> = {}
    const add = (native: string, title: string, kind: 'room' | 'thread', parent?: string) => {
      const n = i.gw.settings.ensureNode('c1', { nativeId: native, kind, title }, parent)
      ids[native] = n.id
      return n
    }
    add('-1', 'Zeta ops', 'room')
    add('-2', 'Alpha sales', 'room')
    add('-3', '100% legal', 'room')
    add('-4', 'Forum', 'room')
    add('-4/1', 'Produksi', 'thread', '-4')
    add('-4/2', 'Sales', 'thread', '-4')
    i.gw.settings.set(ids['-1'] as string, { enabled: true })
    return { i, ids }
  }
  const run = (i: Instance, q: Record<string, unknown>, allowedByDefault = false) =>
    i.gw.nodes.table('c1', { ...page(), ...q } as never, { allowedByDefault })

  test('lists chats by default (no topics), counts exactly and pages in SQL', () => {
    const { i } = seeded()
    const all = run(i, { sort: 'title', order: 'asc' })
    expect(all.total).toBe(4)
    expect(all.items.map((n) => n.title)).toEqual([
      '100% legal',
      'Alpha sales',
      'Forum',
      'Zeta ops',
    ])
    const second = run(i, { sort: 'title', order: 'asc', page: 2, limit: 3 })
    expect(second.total).toBe(4)
    expect(second.items.map((n) => n.title)).toEqual(['Zeta ops'])
    expect(run(i, { sort: 'title', order: 'desc', limit: 1 }).items[0]?.title).toBe('Zeta ops')
    // beyond the last page: no rows, the total stays
    expect(run(i, { page: 9 })).toMatchObject({ items: [], total: 4 })
  })

  test('topics of one chat, and level all', () => {
    const { i, ids } = seeded()
    expect(
      run(i, { level: 'topic', parentId: ids['-4'] })
        .items.map((n) => n.title)
        .sort(),
    ).toEqual(['Produksi', 'Sales'])
    expect(run(i, { level: 'all' }).total).toBe(6)
  })

  test('search is literal: % and _ are not wildcards', () => {
    const { i } = seeded()
    expect(run(i, { q: 'sales' }).items.map((n) => n.title)).toEqual(['Alpha sales'])
    expect(run(i, { q: '100%' }).items.map((n) => n.title)).toEqual(['100% legal'])
    expect(run(i, { q: '%' }).total).toBe(1)
    expect(run(i, { q: '_' }).total).toBe(0)
  })

  test('the allowed filter follows the setting in force, the default and a topic inherits its chat', () => {
    const { i, ids } = seeded()
    expect(run(i, { allowed: true }).items.map((n) => n.title)).toEqual(['Zeta ops'])
    expect(run(i, { allowed: false }).total).toBe(3)
    // an open connection allows every chat that does not say otherwise
    expect(run(i, { allowed: true }, true).total).toBe(4)
    i.gw.settings.set(ids['-4'] as string, { enabled: true })
    expect(run(i, { level: 'topic', allowed: true }).total).toBe(2)
    i.gw.settings.set(ids['-4/1'] as string, { enabled: false })
    expect(run(i, { level: 'topic', allowed: true }).items.map((n) => n.title)).toEqual(['Sales'])
  })

  test('account filters read the history window and the admin rights', () => {
    const { i, ids } = seeded()
    i.gw.nodes.patchHistory(ids['-2'] as string, 'c1', { days: 30, state: 'done', count: 12 }, 1)
    i.gw.nodes.setAccess(ids['-1'] as string, 'c1', { member: 'admin' }, 1)
    expect(run(i, { history: true }).items.map((n) => n.title)).toEqual(['Alpha sales'])
    expect(run(i, { admin: true }).items.map((n) => n.title)).toEqual(['Zeta ops'])
    expect(run(i, { sort: 'messages', order: 'desc' }).items[0]?.title).toBe('Alpha sales')
  })

  test('an unknown sort falls back to the default instead of reaching the SQL', () => {
    const { i } = seeded()
    expect(run(i, { sort: 'title; DROP TABLE ch_nodes' }).total).toBe(4)
    expect(i.gw.nodes.count('c1')).toBe(6)
  })
})

describe('people table', () => {
  function seeded() {
    const i = instance()
    i.gw.configure({ connectionId: 'c1', agentId: i.leadId })
    const names = ['Ana', 'Budi', 'Citra', 'Dewi', 'Eko']
    names.forEach((name, n) => {
      i.gw.identities.upsert(
        'c1',
        { id: String(2000 + n), name, username: name.toLowerCase() },
        { now: 1000 + n },
      )
    })
    return i
  }
  const run = (i: Instance, q: Record<string, unknown>) =>
    i.gw.people.table('c1', { ...page(), ...q } as never)

  test('pages, sorts by name and counts', () => {
    const i = seeded()
    const first = run(i, { sort: 'name', order: 'asc', limit: 2 })
    expect(first.total).toBe(5)
    expect(first.items.map((p) => p.name)).toEqual(['Ana', 'Budi'])
    expect(
      run(i, { sort: 'name', order: 'asc', limit: 2, page: 3 }).items.map((p) => p.name),
    ).toEqual(['Eko'])
    // the default: most recently seen first
    expect(run(i, {}).items[0]?.name).toBe('Eko')
  })

  test('search matches the name, the username and the platform id', () => {
    const i = seeded()
    expect(run(i, { q: 'cit' }).items.map((p) => p.name)).toEqual(['Citra'])
    expect(run(i, { q: '@dewi' }).items.map((p) => p.name)).toEqual(['Dewi'])
    expect(run(i, { q: '2001' }).items.map((p) => p.name)).toEqual(['Budi'])
  })

  test('role and link filters', () => {
    const i = seeded()
    i.gw.people.setRole('c1', '2001', { role: 'admin' }, 'owner')
    i.gw.pairing.link('c1', '2002', 'owner')
    expect(run(i, { role: 'admin' }).items.map((p) => p.name)).toEqual(['Budi'])
    expect(run(i, { linked: true }).items.map((p) => [p.name, p.memberId])).toEqual([
      ['Citra', 'owner'],
    ])
    expect(run(i, { linked: false }).total).toBe(4)
    i.gw.unlinked.ignore('c1', '2003', true)
    expect(run(i, { ignored: true }).items.map((p) => p.name)).toEqual(['Dewi'])
    expect(run(i, { ignored: true }).items[0]?.ignored).toBe(true)
  })
})

describe('activity table', () => {
  test('filters by type and person, searches, orders and counts', () => {
    const i = instance()
    i.gw.configure({ connectionId: 'c1', agentId: i.leadId })
    const room = i.gw.settings.ensureNode('c1', { nativeId: '-9', kind: 'room', title: 'Finance' })
    for (let n = 0; n < 7; n++) {
      i.gw.activity.record({
        connectionId: 'c1',
        type: n % 2 === 0 ? 'woke' : 'dropped',
        conversationId: room.id,
        peerId: n < 3 ? '77' : '88',
        peerName: n < 3 ? 'Ana' : 'Budi',
        ...(n % 2 === 0 ? {} : { reason: 'chat-not-allowed' }),
        at: 1000 + n,
      })
    }
    const all = i.gw.activity.table('c1', { page: 1, limit: 3 })
    expect(all.total).toBe(7)
    expect(all.items).toHaveLength(3)
    // newest first, and the title of the conversation comes along
    expect(all.items[0]?.at).toBe(1006)
    expect(all.items[0]?.conversationTitle).toBe('Finance')
    expect(i.gw.activity.table('c1', { page: 3, limit: 3 }).items).toHaveLength(1)
    expect(i.gw.activity.table('c1', { page: 1, limit: 50, order: 'asc' }).items[0]?.at).toBe(1000)
    expect(i.gw.activity.table('c1', { page: 1, limit: 50, type: 'dropped' }).total).toBe(3)
    expect(i.gw.activity.table('c1', { page: 1, limit: 50, peerId: '77' }).total).toBe(3)
    expect(i.gw.activity.table('c1', { page: 1, limit: 50, q: 'not-allowed' }).total).toBe(3)
    expect(i.gw.activity.table('c1', { page: 1, limit: 50, q: 'finan' }).total).toBe(7)
    expect(i.gw.activity.table('c1', { page: 1, limit: 50, q: 'budi', type: 'woke' }).total).toBe(2)
  })
})

describe('inbox table', () => {
  test('lists the conversations with activity, filters by kind, searches titles and counts', async () => {
    const i = instance()
    i.gw.configure({ connectionId: 'c1', agentId: i.leadId, rate: { chatMinIntervalMs: 0 } })
    const rooms: Array<[string, string]> = [
      ['-1', 'Ops'],
      ['-2', 'Sales'],
      ['-3', 'Legal'],
    ]
    for (const [native, title] of rooms) {
      const r = i.gw.settings.ensureNode('c1', { nativeId: native, kind: 'room', title })
      i.gw.settings.set(r.id, { enabled: true, wake: 'never' })
    }
    const forum = i.gw.settings.ensureNode('c1', { nativeId: '-4', kind: 'room', title: 'Forum' })
    i.gw.settings.ensureNode('c1', { nativeId: '-4/1', kind: 'thread', title: 'Budget' }, '-4')
    i.gw.settings.set(forum.id, { enabled: true, wake: 'never' })
    const mock = createMockAdapter({ connectionId: 'c1' })
    await i.gw.register(mock)
    const who = { id: '9', name: 'Ana' }
    for (const [n, [native]] of rooms.entries())
      await mock.say({
        chat: native,
        from: who,
        text: `hello ${native}`,
        id: String(n + 1),
        at: 5000 + n,
      })
    await mock.say({ chat: '-4', topic: '1', from: who, text: 'topic line', id: '9', at: 6000 })

    const all = await i.gw.inbox.table('c1', { page: 1, limit: 2 })
    expect(all.total).toBe(4)
    expect(all.items).toHaveLength(2)
    expect(all.items[0]?.title).toBe('Budget') // the most recent first
    expect(all.items[0]?.parentTitle).toBe('Forum')
    expect((await i.gw.inbox.table('c1', { page: 2, limit: 2 })).items).toHaveLength(2)
    expect((await i.gw.inbox.table('c1', { page: 1, limit: 50, kind: 'topic' })).total).toBe(1)
    expect((await i.gw.inbox.table('c1', { page: 1, limit: 50, kind: 'group' })).total).toBe(3)
    // a topic is found by the title of its forum, too
    expect(
      (await i.gw.inbox.table('c1', { page: 1, limit: 50, q: 'forum' })).items.map((c) => c.title),
    ).toEqual(['Budget'])
    const byTitle = await i.gw.inbox.table('c1', {
      page: 1,
      limit: 50,
      sort: 'title',
      order: 'asc',
    })
    expect(byTitle.items.map((c) => c.title)).toEqual(['Budget', 'Legal', 'Ops', 'Sales'])
  })
})

describe('reminders table', () => {
  test('filters by status, searches and counts', () => {
    const i = instance()
    i.gw.configure({ connectionId: 'c1', agentId: i.leadId })
    const room = i.gw.settings.ensureNode('c1', { nativeId: '-1', kind: 'room', title: 'Ops' })
    i.gw.settings.set(room.id, { enabled: true })
    const made: string[] = []
    for (const [n, text] of ['stand up', 'send the report', 'pay the invoice'].entries()) {
      const r = i.gw.reminders.create({
        connectionId: 'c1',
        nodeId: room.id,
        agentId: i.leadId,
        text,
        mentions: [],
        when: { inMinutes: 30 + n } as never,
        createdBy: { name: n === 0 ? 'Ana' : 'Budi', role: 'admin' },
      })
      if ('reminder' in r) made.push(r.reminder.id)
    }
    expect(made).toHaveLength(3)
    i.gw.reminders.cancel(made[1] as string)
    const run = (q: Record<string, unknown>) =>
      i.gw.reminders.table('c1', { ...page(), ...q } as never)
    expect(run({}).total).toBe(3)
    expect(run({ status: 'active' }).total).toBe(2)
    expect(run({ status: 'cancelled' }).items.map((r) => r.body)).toEqual(['send the report'])
    expect(run({ q: 'ana' }).items.map((r) => r.body)).toEqual(['stand up'])
    expect(run({ nodeId: room.id }).total).toBe(3)
    expect(run({ sort: 'text', order: 'asc', limit: 2 }).items.map((r) => r.body)).toEqual([
      'pay the invoice',
      'send the report',
    ])
  })
})
