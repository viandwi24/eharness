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

describe('media in script events', () => {
  test('an album is one event with every item; stickers, formatting, forwards and polls keep what they are', async () => {
    const r = rig()
    rigs.push(r)
    const mock = await withVip(r)
    await r.api('POST', '/tables', { name: 'seen' })
    const src = `export default async function (event, ctx) {
  await ctx.tables.insert({ table: 'seen', rows: [{
    id: event.messageId,
    text: event.text ?? '',
    album: (event.album ?? []).map((m) => m.messageId).join(','),
    media: (event.attachments ?? []).map((a) => a.media + (a.sticker ? ':' + a.sticker.emoji : '')).join(','),
    refs: (event.attachments ?? []).map((a) => a.ref ?? '').join(','),
    bold: (event.entities ?? []).filter((e) => e.type === 'bold').length,
    forward: event.forward?.name ?? '',
    poll: event.content?.type === 'poll' ? event.content.question : '',
  }] })
}`
    const manifest = {
      triggers: [{ kind: 'channel', events: ['message.created'], chats: [CHAT] }],
      grants: { tablesWrite: ['seen'] },
    }
    expect((await r.api('POST', '/scripts', { name: 'media', source: src, manifest })).status).toBe(
      201,
    )
    await r.api('POST', '/scripts/media/activate', {})
    const who = { id: '9', name: 'Zed' }
    const img = (n: string) => ({
      name: `${n}.jpg`,
      mediaType: 'image/jpeg',
      bytes: new Uint8Array([1]),
      media: 'photo' as const,
      ref: `file-${n}`,
    })
    // an album of three: the caption and its bold entity sit on the first item
    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: who,
      id: '101',
      text: 'BUY BTC',
      entities: [{ type: 'bold', offset: 0, length: 3 }],
      groupId: 'g1',
      attachments: [img('a')],
    })
    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: who,
      id: '102',
      text: '',
      groupId: 'g1',
      attachments: [img('b')],
    })
    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: who,
      id: '103',
      text: '',
      groupId: 'g1',
      attachments: [img('c')],
    })
    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: who,
      id: '104',
      text: '',
      attachments: [
        {
          name: 'sticker.webp',
          mediaType: 'image/webp',
          bytes: new Uint8Array([1]),
          media: 'sticker',
          sticker: { emoji: '🚀', format: 'static' },
        },
      ],
    })
    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: who,
      id: '105',
      text: 'news',
      forwardOf: { type: 'channel', name: 'Signals HQ', chat: '-100' },
    })
    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: who,
      id: '106',
      text: '[poll: Long or short?]',
      content: { type: 'poll', question: 'Long or short?', options: ['Long', 'Short'] },
    })
    const rows = async () =>
      (await r.api('POST', '/tables/seen/query', { limit: 50 })).json as {
        rows: Array<{ data: Record<string, unknown> }>
      }
    await until('all seen', async () => (await rows()).rows.length >= 4, 5000)
    await sleep(100)
    const byId = new Map((await rows()).rows.map((x) => [x.data.id, x.data]))
    expect(byId.size).toBe(4)
    expect(byId.get('101')).toMatchObject({
      text: 'BUY BTC',
      album: '101,102,103',
      media: 'photo,photo,photo',
      refs: 'file-a,file-b,file-c',
      bold: 1,
    })
    expect(byId.get('104')).toMatchObject({ media: 'sticker:🚀' })
    expect(byId.get('105')).toMatchObject({ forward: 'Signals HQ' })
    expect(byId.get('106')).toMatchObject({ poll: 'Long or short?' })
    // the stored message keeps its media facts (resend without a download later)
    const gw = r.server.channels
    const node = gw.nodes.list('c1').find((n) => n.nativeId === CHAT)
    const stored = await gw.log.find(node?.id ?? '', '102')
    expect(stored).toMatchObject({
      groupId: 'g1',
      attachments: [{ media: 'photo', ref: 'file-b' }],
    })
  })
})

describe('sending media and copying', () => {
  test('a distributor: an album is copied with a new caption, replies and edits follow the copy, deletions too', async () => {
    const r = rig()
    rigs.push(r)
    const mock = await withVip(r)
    const src = `export default async function (event, ctx) {
  const c = event.connectionId
  const here = { connection: c, chat: event.chat.nativeId }
  if (event.type === 'message.deleted') {
    for (const id of event.messageIds) {
      const { copies } = await ctx.channels.copies({ ...here, messageId: id })
      for (const k of copies) await ctx.channels.delete({ connection: c, chat: k.chat, messageIds: [k.messageId] })
    }
    return { deleted: event.messageIds.length }
  }
  if (event.type === 'message.edited') {
    const { copies } = await ctx.channels.copies({ ...here, messageId: event.messageId })
    for (const k of copies) await ctx.channels.edit({ connection: c, chat: k.chat, messageId: k.messageId, text: '[VIP] ' + event.text })
    return { edited: copies.length }
  }
  if (event.replyTo) {
    const { copies } = await ctx.channels.copies({ ...here, messageId: event.replyTo.messageId })
    for (const k of copies)
      await ctx.channels.send({ connection: c, chat: k.chat, text: event.text, replyTo: k.messageId, silent: true, format: 'plain' })
    return { followed: copies.length }
  }
  if (event.attachments?.[0]?.media === 'sticker') {
    await ctx.channels.send({ connection: c, chat: 'VIP', media: [{ ref: event.attachments[0].ref, kind: 'sticker' }], text: 'from #1' })
    await ctx.channels.react({ ...here, messageId: event.messageId, emoji: '👍', customEmojiId: '5368324170671202286' })
    return { sticker: true }
  }
  const ids = event.album ? event.album.map((m) => m.messageId) : [event.messageId]
  const sent = await ctx.channels.copy({ ...here, messageIds: ids, toChat: 'VIP', caption: '[VIP] ' + (event.text ?? '') })
  return { copied: sent.messageIds }
}`
    const manifest = {
      triggers: [
        {
          kind: 'channel',
          events: ['message.created', 'message.edited', 'message.deleted'],
          chats: [CHAT],
        },
      ],
      grants: {
        send: [
          { connection: 'c1', chat: 'VIP' },
          { connection: 'c1', chat: CHAT },
        ],
        read: [{ connection: 'c1', chat: CHAT }],
      },
    }
    const created = await r.api('POST', '/scripts', { name: 'distributor', source: src, manifest })
    expect(created.status).toBe(201)
    const check = await r.api('POST', '/scripts/distributor/check', {})
    expect(check.json.errors).toBe(0)
    await r.api('POST', '/scripts/distributor/activate', {})
    const who = { id: '9', name: 'Zed' }
    const img = (n: string) => ({
      name: `${n}.jpg`,
      mediaType: 'image/jpeg',
      bytes: new Uint8Array([1]),
      media: 'photo' as const,
      ref: `f-${n}`,
    })
    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: who,
      id: '201',
      text: 'BUY BTC 60k',
      groupId: 'g2',
      attachments: [img('a')],
    })
    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: who,
      id: '202',
      text: '',
      groupId: 'g2',
      attachments: [img('b')],
    })
    await until('album copied', () => mock.copies.length === 1, 5000)
    expect(mock.copies[0]).toMatchObject({ from: CHAT, ids: ['201', '202'], to: '-2002' })
    const copyIds = mock.copies[0]?.messageIds as string[]
    // the caption of the copy is replaced (on the copy of the captioned message)
    await until('caption set', () => mock.edits.some((e) => e.caption === true))
    expect(mock.edits.find((e) => e.caption)).toMatchObject({
      messageId: copyIds[0],
      text: '[VIP] BUY BTC 60k',
    })

    // a reply to the second photo follows under its copy, silently, as plain text
    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: who,
      id: '203',
      text: 'TP1 hit *yes*',
      replyTo: { messageId: '202' },
    })
    await until('reply followed', () => mock.sent.some((s) => s.message.text === 'TP1 hit *yes*'))
    const reply = mock.sent.find((s) => s.message.text === 'TP1 hit *yes*')
    expect(reply?.message).toMatchObject({ replyTo: copyIds[1], silent: true, format: 'plain' })

    // an edit of the signal edits the copy (its caption: the copy has files)
    await mock.userEdit({ chat: CHAT, kind: 'group', from: who, id: '201', text: 'BUY BTC 61k' })
    await until('edit synced', () => mock.edits.some((e) => e.text === '[VIP] BUY BTC 61k'))
    expect(mock.edits.find((e) => e.text === '[VIP] BUY BTC 61k')).toMatchObject({
      messageId: copyIds[0],
      caption: true,
    })

    // a sticker goes out again by its reference (no bytes), and the source gets a custom emoji
    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: who,
      id: '204',
      text: '',
      attachments: [
        {
          name: 's.webp',
          mediaType: 'image/webp',
          bytes: new Uint8Array([1]),
          media: 'sticker',
          ref: 'stk-1',
          sticker: { emoji: '🚀', format: 'static' },
        },
      ],
    })
    await until('sticker sent', () => mock.sent.some((s) => s.message.files?.[0]?.ref === 'stk-1'))
    const st = mock.sent.find((s) => s.message.files?.[0]?.ref === 'stk-1')
    expect(st?.message.files?.[0]).toMatchObject({ media: 'sticker', ref: 'stk-1' })
    expect(st?.message.files?.[0]?.bytes).toBeUndefined()
    await until('reacted', () => mock.reactions.length === 1)
    expect(mock.reactions[0]).toMatchObject({
      messageId: '204',
      customEmojiId: '5368324170671202286',
    })

    // deleting the album deletes both copies
    await mock.userDelete({ chat: CHAT, kind: 'group', ids: ['201', '202'] })
    await until('copies deleted', () => mock.deletes.length === 2)
    expect(mock.deletes.map((d) => d.messageId).sort()).toEqual([...copyIds].sort())
  }, 20_000)

  test('copy refuses chats outside the grants; Check knows copy and forward', async () => {
    const r = rig()
    rigs.push(r)
    await withVip(r)
    const src = `export default async function (event, ctx) {
  await ctx.channels.copy({ connection: 'c1', chat: '${CHAT}', messageIds: ['1'], toChat: 'Elsewhere' })
}`
    await r.api('POST', '/scripts', {
      name: 'copier',
      source: src,
      manifest: {
        triggers: [],
        grants: {
          send: [{ connection: 'c1', chat: 'VIP' }],
          read: [{ connection: 'c1', chat: CHAT }],
        },
      },
    })
    const check = await r.api('POST', '/scripts/copier/check', {})
    const problems = check.json.problems as Array<{ message: string }>
    expect(problems.map((p) => p.message)).toContain('Chat "Elsewhere" is not in grants.send.')
    const run = await r.api('POST', '/scripts/copier/dry-run', { event: { type: 'manual' } })
    expect(JSON.stringify(run.json)).toContain('may not post to Elsewhere')
  })
})

describe('state helpers, later runs and pacing', () => {
  test('kv.once skips duplicates, kv.incr counts, kv.rateLimit holds a window, ttl forgets; a dry run writes nothing', async () => {
    const r = rig()
    rigs.push(r)
    await withVip(r)
    await r.api('POST', '/tables', { name: 'out' })
    const src = `export default async function (event, ctx) {
  if (event.data?.keys) return (await ctx.kv.keys({})).keys
  const key = event.data?.key ?? 'sig-1'
  const first = (await ctx.kv.once({ key: 'seen:' + key, ttlSec: 600 })).first
  const n = (await ctx.kv.incr({ key: 'n' })).value
  const rl = await ctx.kv.rateLimit({ key: 'rl', limit: 2, windowSec: 60 })
  await ctx.kv.set({ key: 'short', value: 1, ttlSec: 0.3 })
  return { first, n, allowed: rl.allowed, remaining: rl.remaining }
}`
    await r.api('POST', '/scripts', {
      name: 'state',
      source: src,
      manifest: { triggers: [], grants: {} },
    })
    // a dry run answers from the stored state without writing
    const dry = await r.api('POST', '/scripts/state/dry-run', { event: { type: 'manual' } })
    expect((dry.json.run as { result: unknown }).result).toEqual({
      first: true,
      n: 1,
      allowed: true,
      remaining: 1,
    })
    expect((dry.json.run as { outcome: string }).outcome).toBe('ok')
    await r.api('POST', '/scripts/state/activate', {})
    const run = async (data?: unknown) =>
      (await r.api('POST', '/scripts/state/run', { event: { type: 'manual', data } })).json.result
    expect(await run()).toEqual({ first: true, n: 1, allowed: true, remaining: 1 })
    expect(await run()).toEqual({ first: false, n: 2, allowed: true, remaining: 0 })
    expect(await run()).toEqual({ first: false, n: 3, allowed: false, remaining: 0 })
    // the short key expires
    await sleep(400)
    const keys = (await run({ keys: true })) as string[]
    expect(keys).toContain('n')
    expect(keys).not.toContain('short')
  }, 15_000)

  test('ctx.later runs the script again with its data; a key replaces the pending one; cancel and list', async () => {
    const r = rig()
    rigs.push(r)
    await withVip(r)
    await r.api('POST', '/tables', { name: 'fired' })
    const src = `export default async function (event, ctx) {
  if (event.type === 'later') {
    await ctx.tables.insert({ table: 'fired', rows: [{ note: event.data.note, key: event.key ?? null }] })
    return 'fired'
  }
  await ctx.later({ in: 0.2, data: { note: 'first' }, key: 'remind' })
  await ctx.later({ in: 0.3, data: { note: 'second' }, key: 'remind' })
  const keep = await ctx.later({ in: 0.2, data: { note: 'plain' } })
  const gone = await ctx.later({ in: 60, data: { note: 'never' } })
  await ctx.cancelLater({ id: gone.id })
  return (await ctx.listLater({})).timers.length
}`
    await r.api('POST', '/scripts', {
      name: 'later',
      source: src,
      manifest: { triggers: [], grants: { tablesWrite: ['fired'] } },
    })
    await r.api('POST', '/scripts/later/activate', {})
    const started = await r.api('POST', '/scripts/later/run', { event: { type: 'manual' } })
    expect(started.json.result).toBe(2)
    const rows = async () =>
      (
        (await r.api('POST', '/tables/fired/query', {})).json.rows as Array<{
          data: Record<string, unknown>
        }>
      ).map((x) => x.data.note)
    await until('later runs', async () => (await rows()).length === 2, 5000)
    await sleep(300)
    expect((await rows()).sort()).toEqual(['plain', 'second'])
    const runs = (await r.api('GET', '/scripts/later/runs')).json.runs as Array<{ trigger: string }>
    expect(runs.filter((x) => x.trigger === 'later')).toHaveLength(2)
  }, 15_000)

  test('a rate-limited send waits and goes out; nothing is left in Needs a look', async () => {
    const r = rig()
    rigs.push(r)
    const mock = await withVip(r)
    const src = `export default async function (event, ctx) {
  const sent = await ctx.channels.send({ connection: 'c1', chat: 'VIP', text: 'paced' })
  return sent.messageIds.length
}`
    await r.api('POST', '/scripts', {
      name: 'pace',
      source: src,
      manifest: { triggers: [], grants: { send: [{ connection: 'c1', chat: 'VIP' }] } },
    })
    await r.api('POST', '/scripts/pace/activate', {})
    const { ChannelError } = await import('../src/infra/channels/types.ts')
    mock.failNext(new ChannelError('rate_limit', 'Too Many Requests: retry after 1', 300, 'chat'))
    const run = await r.api('POST', '/scripts/pace/run', { event: { type: 'manual' } })
    expect(run.json.outcome).toBe('ok')
    expect(mock.sent.map((s) => s.message.text)).toEqual(['paced'])
    const attention = await r.server.channels.outboxAttention('c1', { limit: 20 })
    expect(JSON.stringify(attention.items)).not.toContain('paced')
  }, 15_000)
})

describe('moderation and buttons', () => {
  test('a guard mutes a flooder, a vote uses buttons, presses reach the script and not the agent', async () => {
    const r = rig()
    rigs.push(r)
    const mock = await withVip(r)
    const src = `export default async function (event, ctx) {
  const c = event.connectionId
  const here = { connection: c, chat: event.chat.nativeId }
  if (event.type === 'action') {
    const n = (await ctx.kv.incr({ key: 'votes:' + event.button.data })).value
    await ctx.channels.edit({ ...here, messageId: event.messageId, buttons: [[{ text: 'Yes (' + n + ')', data: 'yes' }], [{ text: 'Rules', url: 'https://example.com/rules' }]] })
    return { voted: event.button.data, n }
  }
  if (event.text === '/vote') {
    await ctx.channels.send({ ...here, text: 'Long or short?', buttons: [[{ text: 'Yes', data: 'yes' }, { text: 'No', data: 'no' }]] })
    return 'asked'
  }
  if (event.text === '/invite') {
    const { link } = await ctx.channels.inviteLink({ ...here, name: 'signals', expireSec: 3600, joinRequest: true })
    return link
  }
  const rl = await ctx.kv.rateLimit({ key: 'flood:' + event.actor.id, limit: 3, windowSec: 60 })
  if (!rl.allowed) {
    await ctx.channels.moderate({ ...here, action: 'mute', user: event.actor.id, forSec: 600 })
    const m = await ctx.channels.member({ ...here, user: event.actor.id })
    return { muted: event.actor.id, status: m.status }
  }
  return 'ok'
}`
    const manifest = {
      triggers: [{ kind: 'channel', events: ['message.created', 'action'], chats: [CHAT] }],
      grants: {
        send: [{ connection: 'c1', chat: CHAT }],
        moderate: [{ connection: 'c1', chat: CHAT }],
      },
    }
    expect((await r.api('POST', '/scripts', { name: 'guard', source: src, manifest })).status).toBe(
      201,
    )
    expect((await r.api('POST', '/scripts/guard/check', {})).json.problems).toEqual([])
    await r.api('POST', '/scripts/guard/activate', {})
    const spam = { id: '77', name: 'Spammer' }
    for (let i = 1; i <= 4; i++)
      await mock.say({ chat: CHAT, kind: 'group', from: spam, id: `f${i}`, text: `spam ${i}` })
    await until('muted', () => mock.moderations.length >= 2)
    expect(mock.moderations[0]?.op).toMatchObject({ action: 'mute', user: '77' })
    expect((mock.moderations[0]?.op as { untilMs?: number } | undefined)?.untilMs).toBeGreaterThan(
      Date.now(),
    )
    expect(mock.moderations[1]?.op).toEqual({ action: 'member', user: '77' })

    const who = { id: '9', name: 'Zed' }
    await mock.say({ chat: CHAT, kind: 'group', from: who, id: 'v1', text: '/vote' })
    await until('vote sent', () => mock.sent.some((s) => s.message.text === 'Long or short?'))
    const vote = mock.sent.find((s) => s.message.text === 'Long or short?')
    expect(vote?.message.buttons).toEqual([
      { name: 's', label: 'Yes', data: 'yes', row: 0 },
      { name: 's', label: 'No', data: 'no', row: 0 },
    ])
    const before = mock.sent.length
    await mock.press({
      chat: CHAT,
      kind: 'group',
      from: who,
      name: 's',
      data: 'yes',
      messageId: vote?.messageId as string,
    })
    await until('buttons edited', () => mock.buttonEdits.length === 1)
    expect(mock.buttonEdits[0]?.buttons).toEqual([
      { name: 's', label: 'Yes (1)', data: 'yes', row: 0 },
      { name: 's', label: 'Rules', url: 'https://example.com/rules', row: 1 },
    ])
    // the press woke no agent: nothing else was sent
    await sleep(200)
    expect(mock.sent.length).toBe(before)

    await mock.say({ chat: CHAT, kind: 'group', from: who, id: 'i1', text: '/invite' })
    await until('link made', () => mock.moderations.some((m) => m.op.action === 'invite_link'))
    expect(mock.moderations.find((m) => m.op.action === 'invite_link')?.op).toMatchObject({
      name: 'signals',
      joinRequest: true,
    })
  }, 20_000)

  test('moderation needs grants.moderate and never targets the connection itself', async () => {
    const r = rig()
    rigs.push(r)
    const mock = await withVip(r)
    const self = mock.self().id
    await r.api('POST', '/scripts', {
      name: 'mod',
      source: `export default async function (event, ctx) {
  return ctx.channels.moderate({ connection: 'c1', chat: '${CHAT}', action: 'ban', user: event.data.user })
}`,
      manifest: { triggers: [], grants: {} },
    })
    const check = await r.api('POST', '/scripts/mod/check', {})
    expect(JSON.stringify(check.json.problems)).toContain('grants.moderate is empty')
    const dry = await r.api('POST', '/scripts/mod/dry-run', {
      event: { type: 'manual', data: { user: '5' } },
    })
    expect(JSON.stringify(dry.json)).toContain('add it to grants.moderate')
    const v = (await r.api('GET', '/scripts/mod')).json.latest as {
      manifest: Record<string, unknown>
    }
    await r.api('PATCH', '/scripts/mod', {
      manifest: { ...v.manifest, grants: { moderate: [{ connection: 'c1', chat: CHAT }] } },
    })
    await r.api('POST', '/scripts/mod/activate', {})
    const run = await r.api('POST', '/scripts/mod/run', {
      event: { type: 'manual', data: { user: self } },
    })
    expect(String(run.json.error)).toContain('never moderates itself')
    expect(mock.moderations).toHaveLength(0)
  })
})

describe('table triggers on field changes', () => {
  test('a script runs when a signal becomes closed (not on other edits), sees before and after, and upserts a summary', async () => {
    const r = rig()
    rigs.push(r)
    await r.api('POST', '/tables', {
      name: 'sig',
      schema: {
        columns: [
          { name: 'ref', type: 'string', unique: true },
          { name: 'status', type: 'string' },
          { name: 'note', type: 'string' },
        ],
      },
    })
    await r.api('POST', '/tables', {
      name: 'stats',
      schema: {
        columns: [
          { name: 'day', type: 'string', unique: true },
          { name: 'closed', type: 'number' },
        ],
      },
    })
    const src = `export default async function (event, ctx) {
  const c = event.changes[0]
  const prev = (await ctx.tables.query({ table: 'stats', filter: { day: 'today' } })).rows[0]
  await ctx.tables.upsert({ table: 'stats', key: 'day', rows: [{ day: 'today', closed: (prev?.data.closed ?? 0) + event.rowIds.length }] })
  return { from: c.before.status, to: c.after.status, changed: c.changed }
}`
    await r.api('POST', '/scripts', {
      name: 'closer',
      source: src,
      manifest: {
        triggers: [
          {
            kind: 'table',
            table: 'sig',
            events: ['row.updated'],
            fields: ['status'],
            where: { status: 'closed' },
            startsToMatch: true,
          },
        ],
        grants: { tablesRead: ['stats'], tablesWrite: ['stats'] },
      },
    })
    await r.api('POST', '/scripts/closer/activate', {})
    const ins = await r.api('POST', '/tables/sig/rows', {
      rows: [
        { ref: 'A', status: 'open' },
        { ref: 'B', status: 'open' },
      ],
    })
    const [a, b] = ins.json.inserted as string[]
    // a note edit: status did not change, no run
    await r.api('PATCH', `/tables/sig/rows/${a}`, { change: { set: { note: 'tp1 hit' } } })
    // open -> closed: runs
    await r.api('PATCH', `/tables/sig/rows/${a}`, { change: { set: { status: 'closed' } } })
    // closed again with another field: still closed, did not start to match: no run
    await r.api('PATCH', `/tables/sig/rows/${a}`, {
      change: { set: { status: 'closed', note: 'x' } },
    })
    // a bulk change closes B
    await r.api('POST', '/tables/sig/update', {
      filter: { ref: 'B' },
      change: { set: { status: 'closed' } },
    })
    const runs = async () =>
      (
        (await r.api('GET', '/scripts/closer/runs')).json.runs as Array<{
          outcome: string
          result: unknown
          trigger: string
        }>
      ).filter((x) => x.trigger === 'table')
    await until('two runs', async () => (await runs()).length === 2, 5000)
    await sleep(200)
    const all = await runs()
    expect(all).toHaveLength(2)
    expect(all.map((x) => x.outcome)).toEqual(['ok', 'ok'])
    expect(all.map((x) => x.result)).toContainEqual({
      from: 'open',
      to: 'closed',
      changed: ['status'],
    })
    const stats = (await r.api('POST', '/tables/stats/query', {})).json.rows as Array<{
      data: Record<string, unknown>
    }>
    expect(stats).toHaveLength(1)
    expect(stats[0]?.data).toEqual({ day: 'today', closed: 2 })
    void b
  }, 15_000)
})

describe('safety: chains, caps, log only, re-runs', () => {
  test("two scripts that write each other's tables stop after one round (a circle)", async () => {
    const r = rig()
    rigs.push(r)
    await r.api('POST', '/tables', { name: 'a' })
    await r.api('POST', '/tables', { name: 'b' })
    const pong = (from: string, to: string) => ({
      source: `export default async function (event, ctx) { await ctx.tables.insert({ table: '${to}', rows: [{ from: '${from}' }] }) }`,
      manifest: {
        triggers: [{ kind: 'table', table: from, events: ['row.created'] }],
        grants: { tablesWrite: [to] },
        maxRunsPerHour: 0,
      },
    })
    await r.api('POST', '/scripts', { name: 'ping', ...pong('a', 'b') })
    await r.api('POST', '/scripts', { name: 'pong', ...pong('b', 'a') })
    await r.api('POST', '/scripts/ping/activate', {})
    await r.api('POST', '/scripts/pong/activate', {})
    await r.api('POST', '/tables/a/rows', { rows: [{ start: true }] })
    await until(
      'pong ran',
      async () => ((await r.api('GET', '/scripts/pong/runs')).json.runs as unknown[]).length > 0,
    )
    await sleep(300)
    // ping ran on the owner's row, pong on ping's row; ping on pong's row is the circle: skipped
    const runs = async (n: string) =>
      (await r.api('GET', `/scripts/${n}/runs`)).json.runs as Array<{
        outcome: string
        reason: string | null
      }>
    expect((await runs('ping')).map((x) => x.outcome)).toEqual(['skipped', 'ok'])
    expect((await runs('ping'))[0]?.reason).toBe('loop')
    expect((await runs('pong')).map((x) => x.outcome)).toEqual(['ok'])
    expect((await r.api('GET', '/tables/a')).json.rowCount).toBe(2)
  })

  test('sends per run and per chat are capped; log only records what would happen', async () => {
    const r = rig()
    rigs.push(r)
    const mock = await withVip(r)
    const src = `export default async function (event, ctx) {
  for (let i = 0; i < 4; i++) await ctx.channels.send({ connection: 'c1', chat: 'VIP', text: 'n' + i })
}`
    await r.api('POST', '/scripts', {
      name: 'chatty',
      source: src,
      manifest: {
        triggers: [],
        grants: { send: [{ connection: 'c1', chat: 'VIP' }] },
        limits: { maxSendsPerChat: 2 },
      },
    })
    await r.api('POST', '/scripts/chatty/activate', {})
    const run = await r.api('POST', '/scripts/chatty/run', {})
    expect(run.json.outcome).toBe('error')
    expect(String(run.json.error)).toContain('limits.maxSendsPerChat = 2')
    expect(mock.sent.map((s) => s.message.text)).toEqual(['n0', 'n1'])

    // log only: the same run sends nothing and the trace shows the calls
    const v = (await r.api('GET', '/scripts/chatty')).json.latest as {
      manifest: Record<string, unknown>
    }
    await r.api('PATCH', '/scripts/chatty', {
      manifest: { ...v.manifest, logOnly: true, limits: {} },
    })
    const act = await r.api('POST', '/scripts/chatty/activate', {})
    expect(act.status).toBe(200)
    const logged = await r.api('POST', '/scripts/chatty/run', {})
    expect(logged.json).toMatchObject({ outcome: 'ok', dryRun: true })
    expect((logged.json.calls as Array<{ dryRun?: boolean }>).every((c) => c.dryRun === true)).toBe(
      true,
    )
    expect(mock.sent).toHaveLength(2)
  })

  test('a failed run is listed and runs again with its message text restored', async () => {
    const r = rig()
    rigs.push(r)
    const mock = await withVip(r)
    await r.api('POST', '/tables', { name: 'seen' })
    await r.api('POST', '/scripts', {
      name: 'flaky',
      source: `export default async function (event, ctx) {
  const n = (await ctx.kv.incr({ key: 'n' })).value
  if (n === 1) throw new Error('first time fails')
  await ctx.tables.insert({ table: 'seen', rows: [{ text: event.text }] })
}`,
      manifest: {
        triggers: [{ kind: 'channel', events: ['message.created'], chats: [CHAT] }],
        grants: { tablesWrite: ['seen'] },
      },
    })
    await r.api('POST', '/scripts/flaky/activate', {})
    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: { id: '9', name: 'Zed' },
      id: 'x1',
      text: 'BUY SOL',
    })
    await until(
      'failed',
      async () =>
        ((await r.api('GET', '/scripts/flaky/runs?outcome=failed')).json.runs as unknown[])
          .length === 1,
    )
    const failed = (
      (await r.api('GET', '/scripts/flaky/runs?outcome=failed')).json.runs as unknown[]
    )[0] as {
      id: string
      event: Record<string, unknown>
    }
    expect(failed.event.text).toBeUndefined()
    const again = await r.api('POST', `/scripts/flaky/runs/${failed.id}/rerun`, {})
    expect(again.json).toMatchObject({
      outcome: 'ok',
      trigger: 'channel',
      startedBy: 'web owner (again)',
    })
    const rows = (await r.api('POST', '/tables/seen/query', {})).json.rows as Array<{
      data: Record<string, unknown>
    }>
    expect(rows.map((x) => x.data.text)).toEqual(['BUY SOL'])
  })
})

describe('P60 acceptance', () => {
  test('the distributor recipe: an album of 3 and a photo go to #2 and #3 in turn; replies and edits follow; nothing is downloaded', async () => {
    const r = rig()
    rigs.push(r)
    const mock = await withVip(r)
    const gw = r.server.channels
    const desk = gw.settings.ensureNode('c1', { nativeId: '-3003', kind: 'room', title: 'Desk' })
    gw.settings.set(desk.id, { enabled: true, label: 'Desk', ack: false } as never)
    const { RECIPES } = await import('../../web/src/lib/scripts/recipes.ts')
    const recipe = RECIPES.find((x) => x.id === 'distribute')
    if (recipe === undefined) throw new Error('no distribute recipe')
    const built = recipe.build({
      from: { connection: 'c1', chat: CHAT },
      to: { connection: 'c1', chat: 'VIP' },
      to2: { connection: 'c1', chat: 'Desk' },
      words: ['buy', 'sell'],
    } as never)
    expect(
      (
        await r.api('POST', '/scripts', {
          name: 'distributor',
          source: built.source,
          manifest: built.manifest,
        })
      ).status,
    ).toBe(201)
    expect((await r.api('POST', '/scripts/distributor/check', {})).json.problems).toEqual([])
    await r.api('POST', '/scripts/distributor/activate', {})
    const who = { id: '9', name: 'Zed' }
    const img = (n: string) => ({
      name: `${n}.jpg`,
      mediaType: 'image/jpeg',
      bytes: new Uint8Array([1]),
      media: 'photo' as const,
      ref: `f-${n}`,
    })
    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: who,
      id: '301',
      text: '**BUY** BTC',
      entities: [{ type: 'bold', offset: 0, length: 3 }],
      groupId: 'g3',
      attachments: [img('a')],
    })
    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: who,
      id: '302',
      text: '',
      groupId: 'g3',
      attachments: [img('b')],
    })
    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: who,
      id: '303',
      text: '',
      groupId: 'g3',
      attachments: [img('c')],
    })
    await until('album copied', () => mock.copies.length === 1, 5000)
    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: who,
      id: '304',
      text: 'SELL ETH',
      attachments: [img('d')],
    })
    await until('photo copied', () => mock.copies.length === 2, 5000)
    expect(mock.copies.map((c) => [c.to, c.ids])).toEqual([
      ['-2002', ['301', '302', '303']],
      ['-3003', ['304']],
    ])
    // a reply to the second album photo follows under its copy in #2
    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: who,
      id: '305',
      text: 'TP1 hit',
      replyTo: { messageId: '302' },
    })
    await until('reply copied', () => mock.copies.length === 3)
    expect(mock.copies[2]).toMatchObject({
      to: '-2002',
      ids: ['305'],
      options: { replyTo: mock.copies[0]?.messageIds[1] },
    })
    // an edit of the photo post updates its copy in #3
    await mock.userEdit({
      chat: CHAT,
      kind: 'group',
      from: who,
      id: '304',
      text: 'SELL ETH (updated)',
    })
    await until('edit followed', () => mock.edits.some((e) => e.text === 'SELL ETH (updated)'))
    expect(mock.edits.find((e) => e.text === 'SELL ETH (updated)')).toMatchObject({
      conversationId: '-3003',
      messageId: mock.copies[1]?.messageIds[0],
      caption: true,
    })
    // nothing was downloaded or uploaded: copies only
    expect(
      mock.sent.filter((s) => (s.message.files ?? []).some((f) => f.bytes !== undefined)),
    ).toHaveLength(0)
  }, 20_000)

  test('a voice note and a poll reach a script with their kind and go out again', async () => {
    const r = rig()
    rigs.push(r)
    const mock = await withVip(r)
    await r.api('POST', '/scripts', {
      name: 'resend',
      source: `export default async function (event, ctx) {
  const here = { connection: event.connectionId, chat: event.chat.nativeId }
  const a = event.attachments?.[0]
  if (a?.media === 'voice') {
    await ctx.channels.send({ connection: event.connectionId, chat: 'VIP', media: [{ ref: a.ref, kind: 'voice' }] })
    return 'voice'
  }
  if (event.content?.type === 'poll') {
    await ctx.channels.copy({ ...here, messageIds: [event.messageId], toChat: 'VIP' })
    return 'poll'
  }
}`,
      manifest: {
        triggers: [
          {
            kind: 'channel',
            events: ['message.created'],
            chats: [CHAT],
            messageKinds: ['voice', 'poll'],
          },
        ],
        grants: {
          send: [{ connection: 'c1', chat: 'VIP' }],
          read: [{ connection: 'c1', chat: CHAT }],
        },
      },
    })
    await r.api('POST', '/scripts/resend/activate', {})
    const who = { id: '9', name: 'Zed' }
    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: who,
      id: 'v1',
      text: '',
      attachments: [
        {
          name: 'v.ogg',
          mediaType: 'audio/ogg',
          bytes: new Uint8Array([1]),
          media: 'voice',
          ref: 'voice-1',
        },
      ],
    })
    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: who,
      id: 'p1',
      text: '[poll: Long?]',
      content: { type: 'poll', question: 'Long?', options: ['Yes', 'No'] },
    })
    await mock.say({ chat: CHAT, kind: 'group', from: who, id: 't1', text: 'just text' })
    await until('both out', () => mock.sent.length === 1 && mock.copies.length === 1)
    expect(mock.sent[0]?.message.files?.[0]).toMatchObject({ media: 'voice', ref: 'voice-1' })
    expect(mock.copies[0]).toMatchObject({ ids: ['p1'], to: '-2002' })
    await sleep(200)
    const runs = (await r.api('GET', '/scripts/resend/runs')).json.runs as unknown[]
    expect(runs).toHaveLength(2)
  }, 15_000)
})

describe('reaction counts', () => {
  test('a script sees the counts of a post and acts when they pass a mark', async () => {
    const r = rig()
    rigs.push(r)
    const mock = await withVip(r)
    await r.api('POST', '/scripts', {
      name: 'hot',
      source: `export default async function (event, ctx) {
  const fire = event.reactions.find((x) => x.emoji === '🔥')?.count ?? 0
  if (fire < 10) return { fire }
  if (!(await ctx.kv.once({ key: 'hot:' + event.messageId, ttlSec: 86400 })).first) return 'told already'
  await ctx.channels.send({ connection: event.connectionId, chat: 'VIP', text: 'Hot post: ' + event.messageId })
  return { fire }
}`,
      manifest: {
        triggers: [{ kind: 'channel', events: ['reactions.updated'], chats: [CHAT] }],
        grants: { send: [{ connection: 'c1', chat: 'VIP' }] },
      },
    })
    await r.api('POST', '/scripts/hot/activate', {})
    const counts = async (n: number, key: string) =>
      mock.emit({
        type: 'reactions.updated',
        dedupeKey: key,
        at: Date.now(),
        node: mock.ref(CHAT, { kind: 'group' }),
        messageNativeId: '500',
        counts: [{ emoji: '🔥', count: n }],
      })
    await counts(3, 'rx1')
    await counts(11, 'rx2')
    await counts(12, 'rx3')
    await until(
      'told once',
      async () => ((await r.api('GET', '/scripts/hot/runs')).json.runs as unknown[]).length === 3,
    )
    expect(mock.sent.map((s) => s.message.text)).toEqual(['Hot post: 500'])
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
