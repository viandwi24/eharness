/**
 * Scripts (P59 W4–W7): the HTTP surface, the approval flow, channel/schedule/table triggers, the
 * gates, auto-disable after repeated failures, the agent tools and the upgrade from 0047.
 */
import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { scriptKey } from '../src/domain/heartbeat.ts'
import { openDatabase } from '../src/infra/db/client.ts'
import {
  CHAT,
  chat,
  connectMock,
  type Rig,
  rig,
  sleep,
  toolCall,
  toolResults,
  until,
} from './support/agent-rig.ts'

const rigs: Rig[] = []
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.close()
})

const HALO = `export default async function (event, ctx) {
  ctx.log('got', event.text)
  await ctx.channels.send({ connection: 'c1', chat: 'VIP', text: 'Forwarded: ' + event.text })
  const n = ((await ctx.kv.get({ key: 'count' })).value ?? 0) + 1
  await ctx.kv.set({ key: 'count', value: n })
  return { forwarded: true, n }
}`

const haloManifest = {
  triggers: [
    { kind: 'channel', events: ['message.created'], chats: [CHAT], textContains: ['halo'] },
  ],
  grants: { send: [{ connection: 'c1', chat: 'VIP' }] },
}

async function withVip(r: Rig) {
  const mock = await connectMock(r)
  const gw = r.server.channels
  const vip = gw.settings.ensureNode('c1', { nativeId: '-2002', kind: 'room', title: 'VIP' })
  gw.settings.set(vip.id, { enabled: true, label: 'VIP', ack: false } as never)
  return mock
}

describe('scripts over HTTP', () => {
  test('create, refuse bad input, dry run, activate, a real chat message runs it, traces, pause, delete', async () => {
    const r = rig()
    rigs.push(r)
    const mock = await withVip(r)

    expect(
      (await r.api('POST', '/scripts', { name: 'Bad Name', source: HALO, manifest: haloManifest }))
        .status,
    ).toBe(400)
    const badManifest = await r.api('POST', '/scripts', {
      name: 'halo',
      source: HALO,
      manifest: { triggers: [{ kind: 'nope' }] },
    })
    expect(badManifest.status).toBe(400)
    expect(badManifest.json.error?.message).toContain(
      'kind is channel, schedule, table, app or webhook',
    )
    const badSource = await r.api('POST', '/scripts', {
      name: 'halo',
      source: 'export default async function (e, ctx) {',
      manifest: haloManifest,
    })
    expect(badSource.status).toBe(400)
    const noDefault = await r.api('POST', '/scripts', {
      name: 'halo',
      source: 'const x = 1',
      manifest: haloManifest,
    })
    expect(noDefault.json.error?.message).toContain('default')

    const created = await r.api('POST', '/scripts', {
      name: 'halo',
      description: 'forward halo',
      source: HALO,
      manifest: haloManifest,
    })
    expect(created.status).toBe(201)
    expect(created.json).toMatchObject({
      name: 'halo',
      status: 'draft',
      latestVersion: 1,
      authorKind: 'person',
    })
    expect(
      (await r.api('POST', '/scripts', { name: 'halo', source: HALO, manifest: haloManifest }))
        .status,
    ).toBe(409)

    const types = await r.api('GET', '/scripts-types')
    expect(types.json.types as string).toContain('channels')

    // dry run on a synthetic event: nothing sent, the trace says what would happen
    const dry = await r.api('POST', '/scripts/halo/dry-run', {
      event: {
        type: 'message.created',
        connectionId: 'c1',
        chat: { nodeId: 'x', nativeId: CHAT, title: 'Ops', rootNativeId: CHAT, rootTitle: 'Ops' },
        actor: { id: '9', name: 'Zed' },
        text: 'halo all',
      },
    })
    expect(dry.status).toBe(200)
    const dryRun = dry.json.run as {
      outcome: string
      dryRun: boolean
      calls: Array<{ method: string; dryRun?: boolean }>
      logs: string[]
      event: Record<string, unknown>
    }
    expect(dryRun.outcome).toBe('ok')
    expect(dryRun.dryRun).toBe(true)
    expect(dryRun.calls.find((c) => c.method === 'channels.send')?.dryRun).toBe(true)
    expect(dryRun.logs.join('\n')).toContain('halo all')
    expect(dryRun.event.text).toBeUndefined()
    expect(dryRun.event.textLength).toBe(8)
    expect(dry.json.triggers).toEqual(['match'])
    expect(mock.sent).toHaveLength(0)

    // a draft does not run on events
    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: { id: '9', name: 'Zed' },
      text: 'halo early',
    })
    await sleep(150)
    expect(mock.sent).toHaveLength(0)
    expect((await r.api('POST', '/scripts/halo/run', {})).status).toBe(409)

    const act = await r.api('POST', '/scripts/halo/activate', {})
    expect(act.json).toMatchObject({
      status: 'active',
      activeVersion: 1,
      approval: { state: 'approved', by: 'web owner' },
    })

    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: { id: '9', name: 'Zed' },
      text: 'nothing here',
    })
    await mock.say({ chat: CHAT, kind: 'group', from: { id: '9', name: 'Zed' }, text: 'Halo team' })
    await until('forwarded', () => mock.sent.length >= 1)
    expect(mock.sent[0]?.conversationId).toBe('-2002')
    expect(mock.sent[0]?.rendered).toBe('Forwarded: Halo team')
    await until(
      'recorded',
      async () =>
        ((await r.api('GET', '/scripts/halo/runs?dryRun=false')).json.runs as unknown[]).length ===
        1,
    )
    const runs = (await r.api('GET', '/scripts/halo/runs')).json.runs as Array<{
      id: string
      trigger: string
      outcome: string
      dryRun: boolean
    }>
    expect(runs.map((x) => [x.trigger, x.outcome, x.dryRun])).toEqual([
      ['channel', 'ok', false],
      ['channel', 'ok', true],
    ])
    const one = await r.api('GET', `/scripts/halo/runs/${runs[0]?.id}`)
    expect((one.json.calls as Array<{ method: string }>).map((c) => c.method)).toEqual([
      'channels.send',
      'kv.get',
      'kv.set',
    ])
    expect((await r.api('GET', '/scripts/halo/kv')).json.entries).toEqual([
      { key: 'count', value: '1' },
    ])
    // the agent was never asked (no model call per event)
    expect(r.models.lead?.prompts.length ?? 0).toBe(0)

    // Pause all holds scripts (the skip is logged)
    expect((await r.api('POST', '/workspace/pause', {})).status).toBe(200)
    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: { id: '9', name: 'Zed' },
      text: 'halo paused',
    })
    await until('skip logged', async () =>
      ((await r.api('GET', '/scripts/halo/runs')).json.runs as Array<{ outcome: string }>).some(
        (x) => x.outcome === 'skipped',
      ),
    )
    expect(mock.sent).toHaveLength(1)
    expect((await r.api('POST', '/workspace/resume', {})).status).toBe(200)

    // the feed told the web
    const feed = r.server.conn.sqlite
      .query<{ payload: string }, []>(
        "SELECT payload FROM events WHERE type = 'scripts-changed' ORDER BY seq",
      )
      .all()
      .map((e) => (JSON.parse(e.payload) as { change: string }).change)
    expect(feed).toEqual(expect.arrayContaining(['created', 'dry-run', 'activated', 'ran']))

    const del = await r.api('DELETE', '/scripts/halo')
    expect(del.json).toEqual({ deleted: true })
    expect((await r.api('GET', '/scripts')).json.scripts).toEqual([])
    expect(r.server.conn.sqlite.query('SELECT COUNT(*) AS n FROM script_runs').get()).toEqual({
      n: 0,
    })
  })

  test('a dry run on a recorded event: the event log facts plus the given text, and trigger reasons', async () => {
    const r = rig()
    rigs.push(r)
    const mock = await withVip(r)
    await r.api('POST', '/scripts', { name: 'halo', source: HALO, manifest: haloManifest })
    await mock.say({ chat: CHAT, kind: 'group', from: { id: '9', name: 'Zed' }, text: 'hello' })
    let id = ''
    await until('event stored', async () => {
      const page = await r.api('GET', '/events?source=channel&type=message.created')
      id = ((page.json.items as Array<{ id: string }> | undefined) ?? [])[0]?.id ?? ''
      return id !== ''
    })
    const noText = await r.api('POST', '/scripts/halo/dry-run', { eventId: id })
    expect(noText.json.triggers).toEqual(['the text has none of the words'])
    const withText = await r.api('POST', '/scripts/halo/dry-run', {
      eventId: id,
      text: 'halo there',
    })
    expect(withText.json.triggers).toEqual(['match'])
    expect((withText.json.run as { outcome: string }).outcome).toBe('ok')
    expect(mock.sent).toHaveLength(0)
  })

  test('grants are enforced: an ungranted chat is a failed run with a readable reason', async () => {
    const r = rig()
    rigs.push(r)
    const mock = await withVip(r)
    const src = `export default async function (event, ctx) { await ctx.channels.send({ connection: 'c1', chat: 'Ops', text: 'x' }) }`
    await r.api('POST', '/scripts', {
      name: 'sneaky',
      source: src,
      manifest: { grants: { send: [{ connection: 'c1', chat: 'VIP' }] } },
    })
    await r.api('POST', '/scripts/sneaky/activate', {})
    const run = await r.api('POST', '/scripts/sneaky/run', {})
    expect(run.json.outcome).toBe('error')
    expect(String(run.json.error)).toContain('may not post to Ops')
    expect(mock.sent).toHaveLength(0)
  })

  test('five failed runs in a row switch the script off and raise an alarm', async () => {
    const r = rig()
    rigs.push(r)
    await r.api('POST', '/scripts', {
      name: 'broken',
      source: `export default async function () { throw new Error('boom') }`,
      manifest: {},
    })
    await r.api('POST', '/scripts/broken/activate', {})
    for (let i = 0; i < 5; i++) {
      const run = await r.api('POST', '/scripts/broken/run', {})
      expect(String(run.json.error)).toContain('boom')
    }
    const s = (await r.api('GET', '/scripts/broken')).json.script as {
      status: string
      disabledReason: string
      consecutiveFailures: number
    }
    expect(s).toMatchObject({ status: 'disabled', disabledReason: 'failures' })
    const alarms = r.server.conn.sqlite
      .query<{ subject: string }, []>('SELECT subject FROM alarms')
      .all()
    expect(alarms.map((a) => a.subject)).toContain('script:broken')
    expect((await r.api('POST', '/scripts/broken/run', {})).status).toBe(409)
    // enabling resets the streak
    const on = await r.api('POST', '/scripts/broken/enable', {})
    expect(on.json).toMatchObject({ status: 'active', consecutiveFailures: 0 })
  })

  test('a schedule trigger keeps a system routine in step with the script', async () => {
    const r = rig()
    rigs.push(r)
    const manifest = {
      triggers: [{ kind: 'schedule', spec: { kind: 'every', everyMs: 3_600_000 } }],
    }
    const bad = await r.api('POST', '/scripts', {
      name: 'tick',
      source: 'export default async function () { return 1 }',
      manifest: { triggers: [{ kind: 'schedule', spec: { kind: 'every', everyMs: 5 } }] },
    })
    expect(bad.status).toBe(400)
    const c = await r.api('POST', '/scripts', {
      name: 'tick',
      source: 'export default async function () { return 1 }',
      manifest,
    })
    const id = c.json.id as string
    expect(r.server.deps.routines.getByProgram(scriptKey(id))).toBeUndefined()
    await r.api('POST', '/scripts/tick/activate', {})
    const routine = r.server.deps.routines.getByProgram(scriptKey(id))
    expect(routine?.schedule).toEqual({ kind: 'every', everyMs: 3_600_000 })
    expect((await r.api('GET', '/scripts/tick')).json.script).toMatchObject({
      routineId: routine?.id,
    })
    // routines of scripts are not listed as routines of the agent
    expect(r.server.deps.routines.list({}).some((x) => x.id === routine?.id)).toBe(false)
    await r.api('POST', '/scripts/tick/disable', {})
    expect(r.server.deps.routines.getByProgram(scriptKey(id))).toBeUndefined()
  })

  test('table triggers: a new row runs the script; its own writes do not loop', async () => {
    const r = rig()
    rigs.push(r)
    await r.api('POST', '/tables', { name: 'orders' })
    await r.api('POST', '/tables', { name: 'audit' })
    const src = `export default async function (event, ctx) {
  for (const row of event.rows) await ctx.tables.insert({ table: 'audit', rows: [{ order: row.id, total: row.data.total }] })
  await ctx.tables.update({ table: 'orders', filter: {}, set: { seen: true } })
  return event.rows.length
}`
    await r.api('POST', '/scripts', {
      name: 'auditor',
      source: src,
      manifest: {
        triggers: [{ kind: 'table', table: 'orders', events: ['row.created', 'row.updated'] }],
        grants: { tablesRead: ['orders'], tablesWrite: ['audit', 'orders'] },
      },
    })
    await r.api('POST', '/scripts/auditor/activate', {})
    await r.api('POST', '/tables/orders/rows', { rows: [{ total: 5 }, { total: 7 }] })
    await until(
      'audited',
      async () =>
        (((await r.api('POST', '/tables/audit/query', {})).json.rows as unknown[]) ?? []).length ===
        2,
    )
    await sleep(200)
    const runs = (await r.api('GET', '/scripts/auditor/runs')).json.runs as Array<{
      trigger: string
      outcome: string
      reason: string | null
      error: string | null
    }>
    const real = runs.filter((x) => x.outcome !== 'skipped')
    expect(real.map((x) => [x.trigger, x.outcome, x.error])).toEqual([['table', 'ok', null]])
    // its own update of orders came back as row.updated and was skipped by the loop guard
    expect(runs.filter((x) => x.outcome === 'skipped').map((x) => x.reason)).toEqual(['loop'])
    const orders = (await r.api('POST', '/tables/orders/query', {})).json.rows as Array<{
      data: { seen?: boolean }
    }>
    expect(orders.every((o) => o.data.seen === true)).toBe(true)
    const audit = (await r.api('POST', '/tables/audit/query', { sort: { total: 1 } })).json
      .rows as Array<{ data: { total: number }; createdBy: string }>
    expect(audit.map((x) => x.data.total)).toEqual([5, 7])
    expect(audit[0]?.createdBy).toBe('script:auditor')
  })
})

describe('scripts written by an agent', () => {
  test('the owner asks in the chat: the agent creates, dry-runs and the script runs at once', async () => {
    const r = rig({
      lead: [
        toolCall('scripts_write', {
          action: 'create',
          script: 'halo',
          source: HALO,
          manifest: haloManifest,
        }),
        toolCall('scripts_write', { action: 'request_activation', script: 'halo' }),
        { text: 'running' },
      ],
    })
    rigs.push(r)
    await withVip(r)
    await chat(r, 'lead', 'forward halo from Ops to VIP')
    const out = toolResults(r.models.lead)
    expect(out[1]).toContain('Active: halo runs v1 now (approved by the owner')
    const s = (await r.api('GET', '/scripts/halo')).json.script as {
      status: string
      approval: { state: string; by: string }
    }
    expect(s).toMatchObject({ status: 'active', approval: { state: 'approved', by: 'the owner' } })
  })

  test('with chat approval off: activation waits for the owner; a non-widening fix switches at once; a widening one waits', async () => {
    const fixed = HALO.replace('Forwarded: ', 'Fwd: ')
    const r = rig({
      lead: [
        toolCall('scripts_read', { action: 'types' }),
        toolCall('scripts_write', {
          action: 'create',
          script: 'halo',
          source: HALO,
          manifest: haloManifest,
          note: 'forward halo',
        }),
        toolCall('scripts_write', {
          action: 'dry_run',
          script: 'halo',
          event: {
            type: 'message.created',
            connectionId: 'c1',
            chat: { title: 'Ops', nativeId: CHAT },
          },
          text: 'halo x',
        }),
        toolCall('scripts_write', { action: 'request_activation', script: 'halo', note: 'please' }),
        toolCall('scripts_write', { action: 'delete', script: 'halo' }),
        { text: 'asked' },
        toolCall('scripts_write', {
          action: 'update',
          script: 'halo',
          source: fixed,
          note: 'shorter prefix',
        }),
        toolCall('scripts_write', { action: 'request_activation', script: 'halo' }),
        toolCall('scripts_write', {
          action: 'update',
          script: 'halo',
          manifest: {
            ...haloManifest,
            grants: { ...haloManifest.grants, http: ['api.example.com'] },
          },
        }),
        toolCall('scripts_write', { action: 'request_activation', script: 'halo' }),
        toolCall('scripts_read', { action: 'list' }),
        { text: 'done' },
      ],
    })
    rigs.push(r)
    await withVip(r)
    expect((await r.api('PATCH', '/settings', { scriptsChatApproval: false })).status).toBe(200)
    await chat(r, 'lead', 'forward halo from Ops to VIP')
    const out = toolResults(r.models.lead)
    expect(out[0]).toContain('export default async function')
    expect(out[1]).toContain('Created halo v1 (draft)')
    expect(out[2]).toContain('would channels.send')
    expect(out[2]).toContain('Nothing was sent')
    expect(out[3]).toContain('Asked for approval of halo v1')
    expect(out[4]).toContain('ERROR: deleting removes the script')

    let s = (await r.api('GET', '/scripts/halo')).json.script as {
      status: string
      approval: { state: string; version: number }
      authorKind: string
      createdBy: string
    }
    expect(s).toMatchObject({
      status: 'draft',
      authorKind: 'agent',
      createdBy: 'Lead',
      approval: { state: 'pending', version: 1 },
    })
    const bell = r.server.deps.notifications.list({ open: true, limit: 10 })
    expect(bell.find((n) => n.link === '/scripts/halo')?.title).toContain('waits for your approval')
    // the owner approves on the Scripts page
    const ok = await r.api('POST', '/scripts/halo/approve', { version: 1 })
    expect(ok.json).toMatchObject({
      status: 'active',
      activeVersion: 1,
      approval: { state: 'approved', by: 'web owner' },
    })
    expect(
      r.server.deps.notifications
        .list({ open: true, limit: 10 })
        .some((n) => n.link === '/scripts/halo'),
    ).toBe(false)
    expect((await r.api('POST', '/scripts/halo/approve', {})).status).toBe(409)

    await chat(r, 'lead', 'make the prefix shorter, then add an http grant')
    const more = toolResults(r.models.lead)
    expect(more.some((t) => t.startsWith('Saved halo v2.'))).toBe(true)
    expect(more.some((t) => t.includes('Active: halo runs v2 now'))).toBe(true)
    expect(
      more.some(
        (t) => t.includes('Asked for approval of halo v3') && t.includes('api.example.com'),
      ),
    ).toBe(true)
    expect(more.some((t) => t.includes('active v2, v3 waits for approval'))).toBe(true)
    // the owner says no: v2 keeps running
    const no = await r.api('POST', '/scripts/halo/reject', { note: 'no http' })
    expect(no.json).toMatchObject({
      status: 'active',
      activeVersion: 2,
      approval: { state: 'approved' },
    })
    s = (await r.api('GET', '/scripts/halo')).json.script as typeof s
    expect(s.status).toBe('active')
    const versions = (await r.api('GET', '/scripts/halo/versions')).json.versions as Array<{
      version: number
    }>
    expect(versions.map((v) => v.version)).toEqual([3, 2, 1])
  })

  test('a member in a chat is refused', async () => {
    const r = rig({
      lead: [
        toolCall('scripts_write', {
          action: 'create',
          script: 'x',
          source: 'export default async function () {}',
        }),
        { text: 'sorry' },
      ],
    })
    rigs.push(r)
    const mock = await connectMock(r)
    r.server.channels.people.setRole('c1', '55', { role: 'member' }, 'owner')
    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: { id: '55', name: 'Zed', username: 'zed' },
      text: 'make a script',
      mentionSelf: true,
    })
    await until('answered', () => (r.models.lead?.prompts.length ?? 0) >= 2)
    expect(toolResults(r.models.lead).join('\n')).toContain('Not allowed')
    expect((await r.api('GET', '/scripts')).json.scripts).toEqual([])
  })
})

describe('messages of the connected account itself', () => {
  test('what a person types on the account starts a script (with its reply id); what the app sent does not', async () => {
    const r = rig()
    rigs.push(r)
    const mock = await withVip(r)
    const src = `export default async function (event, ctx) {
  await ctx.tables.insert({ table: 'seen', rows: [{ text: event.text, reply_to: event.replyTo?.messageId ?? null }] })
}`
    await r.api('POST', '/tables', { name: 'seen' })
    await r.api('POST', '/scripts', {
      name: 'log-all',
      source: src,
      manifest: {
        triggers: [{ kind: 'channel', events: ['message.created'], chats: [CHAT] }],
        grants: { tablesWrite: ['seen'] },
      },
    })
    await r.api('POST', '/scripts/log-all/activate', {})
    const me = { ...mock.self(), isSelf: true }
    // typed by the owner of the account on their phone: runs, and sees which message it answers
    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: me,
      id: 'p50',
      text: 'yok buy ges',
      replyTo: { messageId: 'p49' },
    })
    await until(
      'logged',
      async () =>
        ((await r.api('POST', '/tables/seen/query', {})).json.rows as unknown[]).length === 1,
    )
    const rows = (await r.api('POST', '/tables/seen/query', {})).json.rows as Array<{
      data: Record<string, unknown>
    }>
    expect(rows[0]?.data).toEqual({ text: 'yok buy ges', reply_to: 'p49' })
    // sent by the app (stored when it was sent), then echoed back by the platform: skipped as a loop
    const sent = await r.server.channels.post(
      r.server.channels.resolveTarget(r.ids.lead, undefined, {
        connection: 'c1',
        conversation: CHAT,
      }),
      { text: 'buy from the app' },
    )
    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: me,
      id: sent[0] as string,
      text: 'buy from the app',
    })
    await until('skip logged', async () =>
      (
        (await r.api('GET', '/scripts/log-all/runs')).json.runs as Array<{ reason: string | null }>
      ).some((x) => x.reason === 'loop'),
    )
    expect(((await r.api('POST', '/tables/seen/query', {})).json.rows as unknown[]).length).toBe(1)

    // a post in a broadcast channel of the account: the channel is the sender (marked self), typed
    // by the person: it counts
    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: { id: 'chan-1', name: 'TEST MARKETING #1', isSelf: true },
      id: 'p60',
      text: 'sell now',
    })
    await until(
      'channel post logged',
      async () =>
        ((await r.api('POST', '/tables/seen/query', {})).json.rows as unknown[]).length === 2,
    )

    // loop guard off: what the app sent starts it too
    const v = (await r.api('GET', '/scripts/log-all')).json.latest as {
      manifest: Record<string, unknown>
    }
    await r.api('PATCH', '/scripts/log-all', { manifest: { ...v.manifest, loopGuard: false } })
    await r.api('POST', '/scripts/log-all/activate', {})
    const again = await r.server.channels.post(
      r.server.channels.resolveTarget(r.ids.lead, undefined, {
        connection: 'c1',
        conversation: CHAT,
      }),
      { text: 'buy again from the app' },
    )
    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: me,
      id: again[0] as string,
      text: 'buy again from the app',
    })
    await until(
      'app message logged',
      async () =>
        ((await r.api('POST', '/tables/seen/query', {})).json.rows as unknown[]).length === 3,
    )
  })
})

describe('checking a script without running it', () => {
  test('a saved version and a draft: type errors, lint, missing grants', async () => {
    const r = rig()
    rigs.push(r)
    await r.api('POST', '/scripts', { name: 'halo', source: HALO, manifest: haloManifest })
    const saved = await r.api('POST', '/scripts/halo/check', {})
    expect(saved.json).toMatchObject({ ok: true, errors: 0, version: 1 })
    const draft = await r.api('POST', '/scripts/halo/check', {
      source: `export default async function (event: ScriptEvent, ctx: ScriptContext) {
  ctx.channels.send({ connection: 'c1', chat: 'Other', text: event.text })
  await ctx.tables.insert({ table: 'x', rows: [] })
  await ctx.channels.sned({})
  fetch('x')
}`,
    })
    const problems = draft.json.problems as Array<{ line: number; code: string; severity: string }>
    expect(draft.json.ok).toBe(false)
    expect(problems.map((p) => [p.line, p.code])).toEqual(
      expect.arrayContaining([
        [2, 'grant'],
        [2, 'no-floating'],
        [3, 'grant'],
        [4, 'ts2339'],
        [5, 'no-global'],
      ]),
    )
    const none = await r.api('POST', '/scripts/halo/check', { source: 'const x = 1' })
    expect((none.json.problems as Array<{ code: string }>).map((p) => p.code)).toContain(
      'default-export',
    )
  })
})

describe('the full channel API', () => {
  test('a balancer: signals from #1 alternate between two chats, replies follow as replies, photos are copied', async () => {
    const r = rig()
    rigs.push(r)
    const mock = await withVip(r)
    const gw = r.server.channels
    const desk = gw.settings.ensureNode('c1', { nativeId: '-3003', kind: 'room', title: 'Desk' })
    gw.settings.set(desk.id, { enabled: true, label: 'Desk', ack: false } as never)
    await r.api('POST', '/tables', { name: 'routes' })
    const src = `export default async function (event, ctx) {
  const c = event.connectionId
  if (event.replyTo) {
    const found = await ctx.tables.query({ table: 'routes', filter: { source: event.replyTo.messageId }, limit: 1 })
    const route = found.rows[0]
    if (!route) return { skipped: 'not a reply to a signal' }
    const sent = await ctx.channels.send({ connection: c, chat: route.data.chat, text: event.text, replyTo: route.data.target })
    await ctx.tables.insert({ table: 'routes', rows: [{ source: event.messageId, chat: route.data.chat, target: sent.messageIds[0] }] })
    return { followed: route.data.chat }
  }
  if (!/\\b(buy|sell)\\b/i.test(event.text ?? '')) return { skipped: 'no signal' }
  const n = ((await ctx.kv.get({ key: 'n' })).value ?? 0) + 1
  await ctx.kv.set({ key: 'n', value: n })
  const chat = n % 2 === 1 ? 'VIP' : 'Desk'
  const files = []
  for (const a of event.attachments ?? []) {
    const f = await ctx.channels.download({ connection: c, chat: event.chat.nativeId, messageId: event.messageId, attachment: a.id })
    files.push(f.path)
  }
  const sent = await ctx.channels.send({ connection: c, chat, text: event.text, files })
  await ctx.tables.insert({ table: 'routes', rows: [{ source: event.messageId, chat, target: sent.messageIds[0] }] })
  const recent = await ctx.channels.history({ connection: c, chat: event.chat.nativeId, limit: 5 })
  await ctx.notify({ title: 'Signal ' + n + ' to ' + chat })
  return { chat, seen: recent.messages.length }
}`
    const manifest = {
      triggers: [{ kind: 'channel', events: ['message.created'], chats: [CHAT] }],
      grants: {
        send: [
          { connection: 'c1', chat: 'VIP' },
          { connection: 'c1', chat: 'Desk' },
        ],
        read: [{ connection: 'c1', chat: CHAT }],
        tablesWrite: ['routes'],
        notify: true,
      },
    }
    expect(
      (await r.api('POST', '/scripts', { name: 'balancer', source: src, manifest })).status,
    ).toBe(201)
    await r.api('POST', '/scripts/balancer/activate', {})
    const who = { id: '9', name: 'Zed' }
    const png = new Uint8Array([137, 80, 78, 71])
    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: who,
      id: 's1',
      text: 'buy BTC',
      attachments: [{ name: 'chart.png', mediaType: 'image/png', bytes: png }],
    })
    await until('first routed', () => mock.sent.length === 1)
    await mock.say({ chat: CHAT, kind: 'group', from: who, id: 's2', text: 'sell ETH' })
    await until('second routed', () => mock.sent.length === 2)
    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: who,
      id: 's3',
      text: 'TP hit',
      replyTo: { messageId: 's1' },
    })
    await until('reply followed', () => mock.sent.length === 3)
    await mock.say({ chat: CHAT, kind: 'group', from: who, id: 's4', text: 'just chatting' })
    await sleep(200)
    expect(mock.sent.map((x) => [x.conversationId, x.message.text])).toEqual([
      ['-2002', 'buy BTC'],
      ['-3003', 'sell ETH'],
      ['-2002', 'TP hit'],
    ])
    // the photo of signal 1 went along; the follow-up is a reply to the copy of signal 1
    expect(mock.sent[0]?.message.files?.[0]?.name).toBe('chart.png')
    expect(mock.sent[2]?.message.replyTo).toBe(mock.sent[0]?.messageId)
    expect(r.server.deps.notifications.list({ open: true, limit: 20 }).map((n) => n.title)).toEqual(
      expect.arrayContaining(['Signal 1 to VIP', 'Signal 2 to Desk']),
    )
  })

  test('grants hold for every channel method; edit, react, delete, pin, members and actions work when granted', async () => {
    const r = rig()
    rigs.push(r)
    const ran: Array<Record<string, unknown>> = []
    const mock = await (async () => {
      const gw = r.server.channels
      gw.configure({
        connectionId: 'c1',
        agentId: r.ids.lead,
        rate: { chatMinIntervalMs: 0 },
        people: { defaultRole: 'guest', policy: {} },
      })
      const node = gw.settings.ensureNode('c1', { nativeId: CHAT, kind: 'room', title: 'Ops' })
      gw.settings.set(node.id, { enabled: true, label: 'Ops', ack: false } as never)
      const { z } = await import('zod')
      const m = (await import('../src/infra/channels/index.ts')).createMockAdapter({
        connectionId: 'c1',
        actions: [
          {
            name: 'create_channel',
            risk: 'write',
            summary: 'Create a channel',
            schema: z.object({ title: z.string() }),
            run: async (input) => {
              ran.push(input)
              return `Created ${String(input.title)}`
            },
          },
        ],
      })
      await gw.register(m)
      return m
    })()
    const src = `export default async function (event, ctx) {
  const c = 'c1'
  const out = {}
  const s = await ctx.channels.send({ connection: c, chat: 'Ops', text: 'hello' })
  const id = s.messageIds[0]
  await ctx.channels.edit({ connection: c, chat: 'Ops', messageId: id, text: 'hello again' })
  await ctx.channels.react({ connection: c, chat: 'Ops', messageId: id, emoji: '👍' })
  await ctx.channels.pin({ connection: c, chat: 'Ops', messageId: id })
  out.message = (await ctx.channels.message({ connection: c, chat: 'Ops', messageId: id })).text
  out.members = (await ctx.channels.members({ connection: c, chat: 'Ops' })).members.length
  out.chats = (await ctx.channels.chats({ connection: c })).chats.map((x) => x.title)
  out.action = (await ctx.channels.action({ connection: c, name: 'create_channel', input: { title: 'New' } })).result
  await ctx.channels.delete({ connection: c, chat: 'Ops', messageId: id })
  for (const call of [
    () => ctx.channels.send({ connection: c, chat: 'Elsewhere', text: 'x' }),
    () => ctx.channels.history({ connection: c, chat: 'Elsewhere' }),
    () => ctx.channels.action({ connection: c, name: 'ban', input: {} }),
    () => ctx.notify({ title: 'x' }),
    () => ctx.library.delete({ path: '/library/x.md' }),
  ]) {
    try { await call(); out.leak = true } catch (e) { (out.refused ??= []).push(e.message) }
  }
  return out
}`
    await r.api('POST', '/scripts', {
      name: 'all-ops',
      source: src,
      manifest: {
        grants: {
          send: [{ connection: 'c1', chat: 'Ops' }],
          actions: [{ connection: 'c1', name: 'create_channel' }],
        },
      },
    })
    await r.api('POST', '/scripts/all-ops/activate', {})
    const run = await r.api('POST', '/scripts/all-ops/run', {})
    expect(run.json.error).toBeNull()
    const res = run.json.result as Record<string, unknown>
    expect(res).toMatchObject({ message: 'hello again', chats: ['Ops'], action: 'Created New' })
    expect(res.leak).toBeUndefined()
    expect((res.refused as string[]).length).toBe(5)
    expect(String(res.refused)).toContain('add it to grants.send')
    expect(String(res.refused)).toContain('add it to grants.read')
    expect(String(res.refused)).toContain('grants.actions')
    expect(String(res.refused)).toContain('grants.notify')
    expect(ran).toEqual([{ title: 'New' }])
    expect(mock.edits).toHaveLength(1)
    expect(mock.reactions).toHaveLength(1)
    expect(mock.deletes).toHaveLength(1)
  })
})

describe('more inputs and the team API', () => {
  test('an app event starts a script; ctx.api reads and changes through the API; its own events do not loop', async () => {
    const r = rig()
    rigs.push(r)
    const src = `export default async function (event, ctx) {
  const s = await ctx.api.get({ path: '/settings' })
  await ctx.kv.set({ key: 'team', value: s.body.teamName })
  if (s.body.teamName === 'First') await ctx.api.request({ method: 'PATCH', path: '/settings', body: { teamName: 'Second' } })
  return event.type
}`
    const c = await r.api('POST', '/scripts', {
      name: 'watch-settings',
      source: src,
      manifest: {
        triggers: [{ kind: 'app', events: ['settings-changed'] }],
        grants: { api: ['GET /settings', 'PATCH /settings'] },
      },
    })
    expect(c.status).toBe(201)
    await r.api('POST', '/scripts/watch-settings/activate', {})
    expect((await r.api('PATCH', '/settings', { teamName: 'First' })).status).toBe(200)
    await until('ran', async () =>
      (
        (await r.api('GET', '/scripts/watch-settings/runs?dryRun=false')).json.runs as Array<{
          outcome: string
        }>
      ).some((x) => x.outcome === 'ok'),
    )
    await sleep(200)
    const runs = (await r.api('GET', '/scripts/watch-settings/runs')).json.runs as Array<{
      trigger: string
      outcome: string
      reason: string | null
    }>
    expect(runs.filter((x) => x.outcome === 'ok').map((x) => x.trigger)).toEqual(['app'])
    // its own PATCH came back as settings-changed and was skipped by the loop guard
    expect(runs.filter((x) => x.outcome === 'skipped').map((x) => x.reason)).toEqual(['loop'])
    expect(r.server.deps.settings.get().teamName).toBe('Second')
    expect((await r.api('GET', '/scripts/watch-settings/kv')).json.entries).toEqual([
      { key: 'team', value: '"First"' },
    ])
  })

  test('ctx.api refuses routes outside the grants and the routes no script may call', async () => {
    const r = rig()
    rigs.push(r)
    const src = `export default async function (event, ctx) {
  const out = []
  for (const [m, p] of [['GET', '/agents'], ['GET', '/tasks'], ['POST', '/scripts/x/approve'], ['GET', '/settings/../scripts']]) {
    try { await (m === 'GET' ? ctx.api.get({ path: p }) : ctx.api.request({ method: m, path: p })); out.push(m + ' ' + p + ' ok') }
    catch (e) { out.push(m + ' ' + p + ': ' + e.message) }
  }
  return out
}`
    await r.api('POST', '/scripts', {
      name: 'probe',
      source: src,
      manifest: { grants: { api: ['GET /agents', '* /scripts/**'] } },
    })
    await r.api('POST', '/scripts/probe/activate', {})
    const run = await r.api('POST', '/scripts/probe/run', {})
    expect(run.json.outcome).toBe('ok')
    const out = run.json.result as string[]
    expect(out[0]).toBe('GET /agents ok')
    expect(out[1]).toContain('add "GET /tasks" to grants.api')
    expect(out[2]).toContain('never callable')
    expect(out[3]).toContain('not a clean path')
    expect(
      (
        await r.api('POST', '/scripts', {
          name: 'bad',
          source: src,
          manifest: { grants: { api: ['FETCH /x'] } },
        })
      ).status,
    ).toBe(400)
  })

  test('a webhook: a secret URL runs the active version with the request as the event', async () => {
    const r = rig()
    rigs.push(r)
    const src = `export default async function (event, ctx) {
  ctx.log(event.headers['x-source'] ?? '')
  return { got: event.body.order, method: event.method, q: event.query.k }
}`
    await r.api('POST', '/scripts', {
      name: 'hook',
      source: src,
      manifest: { triggers: [{ kind: 'webhook' }] },
    })
    let wh = (await r.api('GET', '/scripts/hook/webhook')).json as { url: string; live: boolean }
    expect(wh.live).toBe(false)
    const path = new URL(wh.url).pathname.replace(/^\/api/, '')
    // not active yet: 404, nothing runs
    const post = (p: string) =>
      r.app.request(`${p}?k=v`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-source': 'shop',
          authorization: 'Bearer secret',
        },
        body: JSON.stringify({ order: 42 }),
      })
    expect((await post(path)).status).toBe(404)
    await r.api('POST', '/scripts/hook/activate', {})
    wh = (await r.api('GET', '/scripts/hook/webhook')).json as { url: string; live: boolean }
    expect(wh.live).toBe(true)
    const res = await post(path)
    expect(res.status).toBe(200)
    expect((await res.json()).result).toEqual({ got: 42, method: 'POST', q: 'v' })
    // a wrong token is a 404
    expect((await post(`${path.slice(0, -3)}xyz`)).status).toBe(404)
    const runs = (await r.api('GET', '/scripts/hook/runs?dryRun=false')).json.runs as Array<{
      trigger: string
      logs: string[]
      event: { headers: Record<string, string> }
    }>
    expect(runs[0]?.trigger).toBe('webhook')
    expect(runs[0]?.logs).toEqual(['shop'])
    // credentials never reach the script or the trace
    expect(runs[0]?.event.headers.authorization).toBeUndefined()
  })

  test('the manifest JSON Schema and the types know the new triggers and grants', async () => {
    const r = rig()
    rigs.push(r)
    const t = (await r.api('GET', '/scripts-types')).json as {
      types: string
      manifestSchema: { properties: { grants: { properties: Record<string, unknown> } } }
    }
    expect(t.types).toContain('interface ScriptEvent')
    expect(t.types).toContain('api: {')
    expect(Object.keys(t.manifestSchema.properties.grants.properties)).toContain('api')
    expect(JSON.stringify(t.manifestSchema)).toContain('"webhook"')
  })
})

describe('upgrading an older database', () => {
  test('a database at migration 0047 keeps its tables and rows and gains the script tables', () => {
    const DRIZZLE = new URL('../drizzle', import.meta.url).pathname
    const journal = JSON.parse(readFileSync(join(DRIZZLE, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>
    }
    expect(journal.entries.some((e) => e.tag === '0048_scripts')).toBe(true)
    const before = journal.entries.filter((e) => e.idx <= 47)
    const tmp = mkdtempSync(join(tmpdir(), 'team-oldmig-'))
    mkdirSync(join(tmp, 'meta'))
    for (const e of before) cpSync(join(DRIZZLE, `${e.tag}.sql`), join(tmp, `${e.tag}.sql`))
    writeFileSync(join(tmp, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: before }))
    const file = join(mkdtempSync(join(tmpdir(), 'team-upgrade-')), 'team.db')
    const old = new Database(file, { create: true, strict: true })
    migrate(drizzle({ client: old }), { migrationsFolder: tmp })
    old
      .query(
        "INSERT INTO data_tables (id, name, description, schema, created_by, created_at, updated_at, version, row_count, bytes) VALUES ('t1', 'keep', '', '{\"columns\":[]}', 'x', 1, 1, 1, 0, 0)",
      )
      .run()
    old.close()
    const conn = openDatabase(file)
    const names = conn.sqlite
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((t) => t.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'scripts',
        'script_versions',
        'script_runs',
        'script_kv',
        'data_tables',
      ]),
    )
    expect(conn.sqlite.query('SELECT name FROM data_tables').all()).toEqual([{ name: 'keep' }])
    conn.close()
  })
})

describe('heartbeat session for debugging', () => {
  test('the heartbeat session of an agent can be read through the session API', async () => {
    const r = rig()
    rigs.push(r)
    const res = await r.app.request(`/sessions/heartbeat:${r.ids.lead}/messages?limit=5`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { messages: unknown[] }).messages).toEqual([])
    expect((await r.app.request('/sessions/heartbeat:nobody/messages')).status).toBe(404)
  })
})
