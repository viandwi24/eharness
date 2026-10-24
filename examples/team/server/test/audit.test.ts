/**
 * The audit of platform actions: the workspace-wide query (`GET /audit/actions`, filters, cursor
 * paging, CSV), what an agent reads with `platform_action_log` (scoped to its own connections, for
 * staff), and that refused and failed calls are on the trail without a message body.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webCryptoVault } from 'eharness/providers'
import { scriptedModel } from 'eharness/testing'
import { auditCsv, csvField } from '../src/app/audit.ts'
import { createMockAdapter } from '../src/infra/channels/index.ts'
import { PLATFORM_ACTION_LOG_TOOL, selfTools } from '../src/infra/channels/self-tools.ts'
import { compose, type Server } from '../src/main.ts'

// biome-ignore lint/suspicious/noExplicitAny: loose JSON of the API under test
type Json = Record<string, any>

const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const T0 = Date.UTC(2026, 9, 24, 2, 0, 0) // 09:00 in Jakarta

async function world() {
  const dir = mkdtempSync(join(tmpdir(), 'team-audit-'))
  dirs.push(dir)
  const server = compose({
    dbFile: join(dir, 'team.db'),
    instanceId: 'audit-test',
    models: {
      provider: 'scripted',
      defaultModel: 'none',
      resolve: () =>
        scriptedModel([
          () => {
            throw new Error('unexpected model call')
          },
        ]),
    },
    env: {},
    tuning: { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 },
    eventsPollMs: 30,
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
    channels: {
      vault: webCryptoVault(new Uint8Array(32).fill(5)),
      purgeEveryMs: 0,
      maintenanceMs: 0,
    },
  })
  servers.push(server)
  const gw = server.channels
  const agents = server.deps.agents.list()
  const lead = server.deps.agents.getBySlug('lead') as { id: string }
  const other = agents.find((a) => a.id !== lead.id) as { id: string }
  server.deps.settings.patch({ timezone: 'Asia/Jakarta' }, Date.now())
  gw.configure({
    connectionId: 'c1',
    agentId: lead.id,
    people: { defaultRole: 'admin', policy: {} },
    rate: { chatMinIntervalMs: 0 },
  } as never)
  gw.configure({
    connectionId: 'c2',
    agentId: other.id,
    people: { defaultRole: 'admin', policy: {} },
    rate: { chatMinIntervalMs: 0 },
  } as never)
  const room = gw.settings.ensureNode('c1', { nativeId: 'room', kind: 'room', title: 'Ops Room' })
  gw.settings.set(room.id, { enabled: true })
  await gw.register(createMockAdapter({ connectionId: 'c1' }))
  await gw.register(createMockAdapter({ connectionId: 'c2' }))
  const ctx = {
    sessionId: 's-1',
    agentId: lead.id,
    origin: 'chat',
    role: 'owner',
    requester: 'web owner',
  }
  const rec = (
    connectionId: string,
    action: string,
    result: 'ok' | 'error' | 'refused' | 'rate_limited',
    at: number,
    extra: {
      note?: string
      summary?: string
      nodeId?: string
      kind?: 'read'
      requester?: string
      role?: string
      target?: { chat?: string; user?: string; link?: string }
    } = {},
  ) =>
    gw.governor.record(
      {
        connectionId,
        action,
        args: {},
        ...(extra.summary === undefined ? {} : { summary: extra.summary }),
        ...(extra.nodeId === undefined ? {} : { nodeId: extra.nodeId }),
        ...(extra.kind === undefined ? {} : { kind: extra.kind }),
        ...(extra.target === undefined ? {} : { target: extra.target }),
      },
      result,
      {
        at,
        durationMs: 12,
        ...(extra.note === undefined ? {} : { note: extra.note }),
        context: {
          ...ctx,
          ...(extra.requester === undefined ? {} : { requester: extra.requester }),
          ...(extra.role === undefined ? {} : { role: extra.role }),
        },
      },
    )
  rec('c1', 'pin_message', 'ok', T0, { nodeId: room.id, summary: 'chat=room message=5' })
  rec('c1', 'promote_member', 'error', T0 + 1000, {
    nodeId: room.id,
    summary: 'chat=room user=@ana text=<13 chars>',
    note: 'not enough rights',
    target: { chat: 'room', user: '@ana' },
  })
  rec('c1', 'ban_member', 'refused', T0 + 2000, {
    requester: 'Eve',
    role: 'member',
    note: 'needs an admin',
    target: { chat: 'Ops Room', user: '@mallory' },
  })
  rec('c1', 'history', 'ok', T0 + 3000, { kind: 'read', nodeId: room.id })
  rec('c2', 'ban_member', 'ok', T0 + 4000, { requester: 'Zed', role: 'admin' })
  rec('c1', 'unpin_message', 'rate_limited', T0 + 5000, {
    requester: '=HYPERLINK("http://x")',
    note: 'retry in 5 s, "slow"\nsecond line',
  })
  const get = async (path: string) => {
    const res = await server.app.request(path)
    const text = await res.text()
    return {
      status: res.status,
      text,
      json: (res.headers.get('content-type')?.includes('json')
        ? JSON.parse(text)
        : undefined) as Json,
    }
  }
  return { server, gw, lead, other, roomId: room.id, get }
}

describe('GET /audit/actions', () => {
  test('lists actions across connections, newest first, a refused and an error row among them', async () => {
    const w = await world()
    const r = await w.get('/audit/actions')
    expect(r.status).toBe(200)
    // reads are in unless asked otherwise at the API: 6 rows
    expect(r.json.items.map((x: Json) => x.action)).toEqual([
      'unpin_message',
      'ban_member',
      'history',
      'ban_member',
      'promote_member',
      'pin_message',
    ])
    const byResult = (res: string) => r.json.items.filter((x: Json) => x.result === res)
    expect(byResult('refused')).toHaveLength(1)
    expect(byResult('refused')[0]).toMatchObject({
      requester: 'Eve',
      role: 'member',
      note: 'needs an admin',
      connectionId: 'c1',
      durationMs: 12,
    })
    expect(byResult('error')[0]).toMatchObject({
      action: 'promote_member',
      target: { chat: 'Ops Room', user: '@ana' },
      summary: 'chat=room user=@ana text=<13 chars>',
      sessionId: 's-1',
      agentId: w.lead.id,
    })
    expect(r.json.items[0].agentName).toBeTruthy()
    expect(r.json.items.at(-1)).toMatchObject({
      requester: 'web owner',
      role: 'owner',
      origin: 'chat',
    })
  })

  test('filters: connection, kind, action, chat, requester, agent, result, time', async () => {
    const w = await world()
    const ids = async (q: string) =>
      (await w.get(`/audit/actions?${q}`)).json.items.map((x: Json) => x.action)
    expect(await ids('connectionId=c2')).toEqual(['ban_member'])
    expect(await ids('kind=read')).toEqual(['history'])
    expect(await ids('kind=action&connectionId=c1')).toHaveLength(4)
    expect(await ids('action=ban_member')).toHaveLength(2)
    expect(await ids('chat=ops')).toEqual([
      'history',
      'ban_member',
      'promote_member',
      'pin_message',
    ])
    expect(await ids(`chat=${w.roomId}`)).toEqual(['history', 'promote_member', 'pin_message'])
    expect(await ids('requester=eve')).toEqual(['ban_member'])
    expect(await ids('requester=web')).toHaveLength(3)
    expect(await ids(`agentId=${w.lead.id}`)).toHaveLength(6)
    expect(await ids('agentId=nobody')).toEqual([])
    expect(await ids('result=refused')).toEqual(['ban_member'])
    expect(await ids('result=rate_limited')).toEqual(['unpin_message'])
    expect(await ids(`from=${T0 + 1000}&to=${T0 + 3000}`)).toEqual([
      'history',
      'ban_member',
      'promote_member',
    ])
    expect((await w.get('/audit/actions?from=10&to=5')).status).toBe(400)
    // a connector kind: the mock connections are not connector connections, so none is a user account
    expect(await ids('transport=user')).toEqual([])
  })

  test('cursor paging walks every row once', async () => {
    const w = await world()
    const seen: string[] = []
    let cursor = ''
    for (let guard = 0; guard < 10; guard++) {
      const r = await w.get(`/audit/actions?limit=2${cursor === '' ? '' : `&cursor=${cursor}`}`)
      expect(r.json.items.length).toBeLessThanOrEqual(2)
      seen.push(...r.json.items.map((x: Json) => x.id))
      if (r.json.next === undefined) break
      cursor = r.json.next
    }
    expect(seen).toHaveLength(6)
    expect(new Set(seen).size).toBe(6)
  })

  test('no message body anywhere in the output', async () => {
    const w = await world()
    w.gw.governor.record(
      {
        connectionId: 'c1',
        action: 'send_note',
        args: { text: 'private words' } as never,
        summary: undefined as never,
      },
      'ok',
      { at: T0 + 6000 },
    )
    const r = await w.get('/audit/actions')
    expect(r.text).not.toContain('private words')
  })
})

describe('GET /audit/actions.csv', () => {
  test('same filters, escaped fields, formulas defused', async () => {
    const w = await world()
    const res = await w.server.app.request('/audit/actions.csv?result=rate_limited')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/csv')
    expect(res.headers.get('content-disposition')).toContain('attachment')
    const text = await res.text()
    const [header, ...rest] = text.split('\r\n')
    expect(header).toStartWith('time,connection,platform,connector,kind,action,')
    // one row: the note holds a quote, a comma and a line break, so it is quoted and doubled
    expect(text).toContain('"retry in 5 s, ""slow""\nsecond line"')
    // a name that starts like a formula is neutralised (and quoted: it has quotes and a comma)
    expect(text).toContain(`"'=HYPERLINK(""http://x"")"`)
    expect(rest.filter((l) => l !== '')).not.toHaveLength(0)
    const all = await (await w.server.app.request('/audit/actions.csv')).text()
    expect(all.trim().split('\r\n').length).toBeGreaterThanOrEqual(7)
  })

  test('csvField', () => {
    expect(csvField('plain')).toBe('plain')
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('-1001234')).toBe('-1001234')
    expect(csvField('-cmd')).toBe(`'-cmd`)
    expect(csvField('@name')).toBe(`'@name`)
    expect(csvField(undefined)).toBe('')
    expect(csvField(12)).toBe('12')
    expect(auditCsv([])).toBe(
      `${'time,connection,platform,connector,kind,action,chat,user,link,requested_by,role,origin,agent,session,result,duration_ms,summary,note'}\r\n`,
    )
  })
})

describe('platform_action_log (agent tool)', () => {
  const run = async (
    w: Awaited<ReturnType<typeof world>>,
    input: Record<string, unknown>,
    agentId = w.lead.id,
    gw: unknown = w.gw,
  ): Promise<string> => {
    const tools = selfTools({
      gw: gw as never,
      sessionId: 'web-session',
      agentId,
      origin: 'dm',
    }) as Record<string, { execute: (i: unknown, o: unknown) => Promise<string> }>
    const t = tools[PLATFORM_ACTION_LOG_TOOL]
    if (t === undefined) throw new Error('tool missing')
    return t.execute(input, { toolCallId: 'x', messages: [] })
  }

  test('compact lines with time, kind, action, chat, user, requester, result', async () => {
    const w = await world()
    const out = await run(w, { since: '2026-10-24' })
    expect(out).toContain(
      '2026-10-24 09:00 Asia/Jakarta · mock bot · pin_message · chat Ops Room · by web owner',
    )
    expect(out).toMatch(
      /promote_member · chat Ops Room · user @ana · by web owner · error · not enough rights · chat=room user=@ana text=13 chars/,
    )
    expect(out).toMatch(
      /ban_member · chat Ops Room · user @mallory · by Eve \(member\) · refused · needs an admin/,
    )
    // reads only on request
    expect(out).not.toContain('history')
    expect(await run(w, { reads: true })).toContain('history')
  })

  test('scoped to the agent own connections: another agent connection is never shown', async () => {
    const w = await world()
    const mine = await run(w, {})
    expect(mine).not.toContain('Zed')
    expect(mine).toContain('Platform actions on c1')
    const theirs = await run(w, {}, w.other.id)
    expect(theirs).toContain('Zed')
    expect(theirs).not.toContain('Eve')
    // naming a connection that is not bound is refused readably
    expect(await run(w, { connection: 'c2' })).toContain('not one of yours')
  })

  test('filters, limit and paging', async () => {
    const w = await world()
    const refused = await run(w, { result: 'refused' })
    expect(refused.split('\n').filter((l) => l.includes(' · ')).length).toBe(1)
    const page1 = await run(w, { limit: 2 })
    expect(page1).toContain('More: call again with page=')
    const cursor = /page="([^"]+)"/.exec(page1)?.[1] as string
    const page2 = await run(w, { limit: 50, page: cursor })
    expect(page2).toContain('pin_message')
    expect(page2).not.toContain('unpin_message')
    expect(await run(w, { until: '2026-10-23' })).toContain('No platform actions recorded')
    expect(await run(w, { since: 'next week' })).toContain('Could not read')
  })

  test('members are refused; message text never appears', async () => {
    const w = await world()
    const asMember = { ...w.gw, requesterOf: async () => ({ role: 'member', name: 'Eve' }) }
    expect(await run(w, {}, w.lead.id, asMember)).toContain('Not allowed')
    expect(await run(w, {})).not.toContain('private words')
  })
})
