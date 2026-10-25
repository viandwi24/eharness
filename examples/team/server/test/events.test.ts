/**
 * The event stream end to end on the composed server: one query over chat events and app events
 * (filters, paging), join requests as events, the catalog each adapter declares, the
 * `events_recent` agent tool, and an upgrade from an older database.
 */
import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { webCryptoVault } from 'eharness/providers'
import { type ScriptedModel, type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { updateAgent } from '../src/app/agents.ts'
import { raiseAlarm } from '../src/app/alarms.ts'
import type { StreamEvent } from '../src/domain/event-stream.ts'
import { createMockAdapter, type MockAdapter } from '../src/infra/channels/index.ts'
import type { AdapterEventType } from '../src/infra/channels/types.ts'
import { openDatabase } from '../src/infra/db/client.ts'
import type { ModelConfig } from '../src/infra/eh/provider.ts'
import { TELEGRAM_BOT_EVENTS } from '../src/infra/telegram/events.ts'
import { TELEGRAM_ACCOUNT_EVENTS } from '../src/infra/telegram-user/events.ts'
import { compose, type Server } from '../src/main.ts'
import { postAs, userMessage } from './support/http.ts'

const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const TUNING = { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: string, condition: () => boolean | Promise<boolean>, ms = 6000) {
  const end = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(15)
  }
}
const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

// --- the rig -----------------------------------------------------------------------------------

const CHAT = '-1001'

function instance(
  script: Partial<Record<'lead' | 'researcher', ScriptedStepInput[]>> = {},
  dir = mkdtempSync(join(tmpdir(), 'team-events-')),
) {
  if (!dirs.includes(dir)) dirs.push(dir)
  const models: Record<string, ScriptedModel> = {}
  for (const [slug, steps] of Object.entries(script)) models[slug] = scriptedModel(steps)
  const config: ModelConfig = {
    provider: 'scripted',
    defaultModel: 'none',
    resolve: (id) => {
      const slug = (id ?? '').replace('m-', '')
      let model = models[slug]
      if (model === undefined) {
        model = scriptedModel([
          () => {
            throw new Error(`unexpected model call of ${slug}`)
          },
        ])
        models[slug] = model
      }
      return model
    },
  }
  const server = compose({
    dbFile: join(dir, 'team.db'),
    instanceId: 'events-test',
    models: config,
    env: {},
    tuning: TUNING,
    eventsPollMs: 30,
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
    turnRetry: { tickMs: 0, retryUnknown: false },
    channels: {
      vault: webCryptoVault(new Uint8Array(32).fill(9)),
      collect: { quietMs: 60, maxWaitMs: 500, maxItems: 20 },
      typingEveryMs: 20,
      purgeEveryMs: 0,
      maintenanceMs: 0,
      delivery: { retryBaseMs: 20, retryMaxMs: 80 },
    },
  })
  servers.push(server)
  const ids: Record<string, string> = {}
  for (const slug of ['lead', 'researcher']) {
    const def = server.deps.agents.getBySlug(slug)
    if (def === undefined) throw new Error('seed missing')
    updateAgent(server.deps, def.id, { model: `m-${slug}` })
    ids[slug] = def.id
  }
  return { server, app: server.app, models, ids, dir }
}
type Rig = ReturnType<typeof instance>

const joiner = { id: '55', name: 'Zed', username: 'zed' }
const room = {
  nativeId: CHAT,
  kind: 'room' as const,
  title: 'Ops',
  traits: { multiUser: true, threading: 'relation' as const },
}

async function connect(
  r: Rig,
  options: { events?: AdapterEventType[] } = {},
): Promise<MockAdapter> {
  const gw = r.server.channels
  gw.configure({
    connectionId: 'c1',
    agentId: r.ids.lead as string,
    rate: { chatMinIntervalMs: 0 },
    people: { defaultRole: 'guest', policy: {} },
  })
  const node = gw.settings.ensureNode('c1', { nativeId: CHAT, kind: 'room', title: 'Ops' })
  gw.settings.set(node.id, { enabled: true, label: 'Ops', ack: false } as never)
  const mock = createMockAdapter({ connectionId: 'c1', ...options })
  await gw.register(mock)
  return mock
}

let seq = 0
/** A join request as the gateway receives it (the way an adapter delivers it). */
async function joinRequest(
  r: Rig,
  who: { id: string; name: string; username?: string } = joiner,
  at = Date.now(),
): Promise<void> {
  await r.server.channels.handle('c1', {
    type: 'member.join_requested',
    dedupeKey: `jr:${who.id}:${at}:${seq++}`,
    at,
    node: { nativeId: CHAT, chain: [room] },
    actor: who,
    request: { link: 'https://t.me/+xyz', hasBio: true, pending: 1 },
  })
}

interface Page {
  items: StreamEvent[]
  next?: string
}
const events = async (r: Rig, query = ''): Promise<Page> =>
  (await (await r.app.request(`/events${query}`)).json()) as Page

// --- the unified stream --------------------------------------------------------------------------

describe('the event stream', () => {
  test('a join request is an event with the applicant, the chat and no bio; filters narrow it', async () => {
    const r = instance()
    await connect(r)
    r.server.channels.people.setRole('c1', joiner.id, { role: 'member' }, 'owner')
    await joinRequest(r)
    const page = await events(r, '?type=member.join_requested')
    expect(page.items).toHaveLength(1)
    const e = page.items[0] as StreamEvent
    expect(e).toMatchObject({
      source: 'channel',
      connectionId: 'c1',
      type: 'member.join_requested',
      chat: { title: 'Ops', nativeId: CHAT },
      actor: { id: '55', name: 'Zed', username: 'zed', role: 'member' },
      agentCaused: false,
    })
    expect(e.summary).toBe('Zed @zed asked to join in "Ops" through an invite link; 1 pending')
    expect(e.fields).toMatchObject({ user: '55', link: 'https://t.me/+xyz', hasBio: 'true' })
    expect(JSON.stringify(e)).not.toContain('bio:')
    // each filter
    expect((await events(r, '?source=app&type=member.join_requested')).items).toHaveLength(0)
    expect((await events(r, '?connectionId=nope')).items).toHaveLength(0)
    expect((await events(r, '?chat=Ops&type=member.join_requested')).items).toHaveLength(1)
    expect((await events(r, '?chat=elsewhere&type=member.join_requested')).items).toHaveLength(0)
    expect((await events(r, '?actor=zed&type=member.join_requested')).items).toHaveLength(1)
    expect((await events(r, '?actor=55&type=member.join_requested')).items).toHaveLength(1)
    expect((await events(r, '?actor=somebody&type=member.join_requested')).items).toHaveLength(0)
    const from = e.at + 1000
    expect((await events(r, `?from=${from}&type=member.join_requested`)).items).toHaveLength(0)
    expect((await events(r, `?to=${from}&type=member.join_requested`)).items).toHaveLength(1)
    expect((await r.app.request('/events?type=nonsense')).status).toBe(400)
    // the detail by id, and an unknown id
    const one = await r.app.request(`/events/${encodeURIComponent(e.id)}`)
    expect(((await one.json()) as StreamEvent).id).toBe(e.id)
    expect((await r.app.request('/events/ch:unknown')).status).toBe(404)
    expect((await r.app.request('/events/garbage')).status).toBe(404)
  })

  test('a message is an event without its text, from the person, with their role', async () => {
    const r = instance()
    const mock = await connect(r)
    r.server.channels.people.setRole('c1', joiner.id, { role: 'admin' }, 'owner')
    await mock.say({ chat: CHAT, kind: 'group', from: joiner, text: 'my secret card number 4111' })
    const page = await events(r, '?type=message.created')
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({
      actor: { id: '55', role: 'admin' },
      summary: 'Zed @zed wrote in "Room"',
    })
    expect(JSON.stringify(page)).not.toContain('4111')
  })

  test('app events appear in the same list: an alarm, a settings change', async () => {
    const r = instance()
    raiseAlarm(r.server.deps, {
      kind: 'run-failed',
      key: 'k1',
      subject: 'system:test',
      text: 'The nightly import failed. Open the run.',
    })
    await r.app.request('/settings', json('PATCH', { teamName: 'Acme' }))
    const all = await events(r, '?source=app')
    const types = all.items.map((e) => e.type)
    expect(types).toContain('alarm.raised')
    expect(types).toContain('settings.changed')
    const a = all.items.find((e) => e.type === 'alarm.raised') as StreamEvent
    expect(a.fields.kind).toBe('run-failed')
    expect(a.summary).toContain('The nightly import failed')
    expect(a.link).toBe('/attention')
    // noise of the feed is not an event: message previews, model calls
    expect(types).not.toContain('message-added')
  })

  test('both sources merge newest first and paging neither repeats nor skips', async () => {
    const r = instance()
    await connect(r)
    const base = Date.now() - 600_000
    for (let i = 0; i < 6; i++) {
      await joinRequest(r, { id: String(100 + i), name: `U${i}` }, base + i * 2000)
      r.server.deps.events.append({
        type: 'alarm-raised',
        payload: { kind: 'system', subject: `s${i}`, text: `a${i}` },
        at: base + i * 2000 + 1000,
      })
    }
    const seen: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 10; guard++) {
      const page = await events(
        r,
        `?limit=4&type=member.join_requested,alarm.raised${cursor === undefined ? '' : `&cursor=${cursor}`}`,
      )
      seen.push(...page.items.map((e) => e.id))
      if (page.next === undefined) break
      cursor = page.next
    }
    expect(seen).toHaveLength(12)
    expect(new Set(seen).size).toBe(12)
    const full = (await events(r, '?limit=50&type=member.join_requested,alarm.raised')).items
    expect(full.map((e) => e.id)).toEqual(seen)
    expect(full.map((e) => e.at)).toEqual([...full.map((e) => e.at)].sort((a, b) => b - a))
  })

  test('the catalog of one connection holds only what its adapter delivers, with its notes', async () => {
    const r = instance()
    await connect(r, {
      events: [
        { type: 'member.join_requested', note: 'Only where the bot is an admin.' },
        { type: 'message.created', note: 'Every message the bot sees.' },
      ],
    })
    type Catalog = { types: Array<{ type: string; label: string; note?: string }> }
    const all = (await (await r.app.request('/events/catalog')).json()) as Catalog
    expect(all.types.some((t) => t.type === 'alarm.raised')).toBe(true)
    expect(all.types.every((t) => t.note === undefined)).toBe(true)
    const one = (await (await r.app.request('/events/catalog?connectionId=c1')).json()) as Catalog
    expect(one.types.map((t) => t.type)).toEqual(['member.join_requested', 'message.created'])
    expect(one.types[0]).toMatchObject({
      label: 'Somebody asked to join a chat that needs approval',
      note: 'Only where the bot is an admin.',
    })
  })

  test('an adapter that declares no events offers every chat type, without notes', async () => {
    const r = instance()
    await connect(r)
    const one = (await (await r.app.request('/events/catalog?connectionId=c1')).json()) as {
      types: Array<{ type: string; source: string; note?: string }>
    }
    expect(one.types.length).toBeGreaterThan(5)
    expect(one.types.every((t) => t.source === 'channel' && t.note === undefined)).toBe(true)
  })

  test('the Telegram bot and account each declare what they deliver', () => {
    const bot = TELEGRAM_BOT_EVENTS.map((e) => e.type)
    const account = TELEGRAM_ACCOUNT_EVENTS.map((e) => e.type)
    // the Bot API never reports deletions; an account never sees other people's reactions or buttons
    expect(bot).not.toContain('message.deleted')
    expect(account).toContain('message.deleted')
    expect(account).not.toContain('reaction.added')
    expect(account).not.toContain('action')
    expect(bot).toContain('member.join_requested')
    expect(account).toContain('member.join_requested')
  })
})

// --- the agent tools -----------------------------------------------------------------------------

/** The text of the tool results of a scripted turn (the results the model read). */
function results(m: ScriptedModel | undefined): string[] {
  const out: string[] = []
  for (const prompt of m?.prompts ?? []) {
    for (const msg of prompt as unknown as Array<{ role: string; content: unknown }>) {
      if (msg.role !== 'tool' || !Array.isArray(msg.content)) continue
      for (const part of msg.content as Array<{ output?: { value?: unknown; reason?: unknown } }>) {
        const v = part.output?.value ?? part.output?.reason
        if (typeof v === 'string' && !out.includes(v)) out.push(v)
      }
    }
  }
  return out
}
const call = (input: Record<string, unknown>, tool = 'events_recent'): ScriptedStepInput => ({
  toolCalls: [{ toolName: tool, input }],
})
async function chat(r: Rig, slug: string, text: string): Promise<void> {
  const id = r.ids[slug] as string
  const res = await r.app.request(`/sessions/dm:${id}/chat`, postAs(`dm:${id}`, userMessage(text)))
  expect(res.status).toBe(200)
  await res.text()
}

describe('the agent tools', () => {
  test('events_recent answers in lines with the ids to act with, and no message text', async () => {
    const r = instance({
      lead: [call({ types: ['member.join_requested'] }), { text: 'ok' }],
    })
    await connect(r)
    await joinRequest(r)
    await chat(r, 'lead', 'what happened?')
    const out = results(r.models.lead)
    const line = out.find((x) => x.startsWith('Events, newest first')) as string
    expect(line).toContain('member.join_requested')
    expect(line).toContain('Zed @zed asked to join in "Ops"')
    expect(line).toContain('chat=-1001')
    expect(line).toContain('user=55')
    expect(line).toMatch(/id ch:/)
  })

  test('a member in a chat is refused with a sentence', async () => {
    const r = instance({ lead: [call({}), { text: 'sorry' }] })
    const mock = await connect(r)
    r.server.channels.people.setRole('c1', joiner.id, { role: 'member' }, 'owner')
    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: joiner,
      text: 'what happened here?',
      mentionSelf: true,
    })
    await until('answered', () => (r.models.lead?.prompts.length ?? 0) >= 2)
    expect(results(r.models.lead).join('\n')).toContain('Not allowed')
  })
})

// --- upgrading -----------------------------------------------------------------------------------

describe('upgrading an older database', () => {
  test('settings saved for the removed triggers are dropped when read and gone after a save', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-retired-'))
    dirs.push(dir)
    const conn = openDatabase(join(dir, 'team.db'))
    conn.sqlite
      .query("INSERT INTO settings (key, value, updated_at) VALUES ('workspace', ?, 1)")
      .run(
        JSON.stringify({ teamName: 'Keep me', triggersMaxPerHour: 5, triggerLogRetentionDays: 7 }),
      )
    conn.close()
    const r = instance({}, dir)
    const got = (await (await r.app.request('/settings')).json()) as Record<string, unknown>
    expect(got.teamName).toBe('Keep me')
    expect(got).not.toHaveProperty('triggersMaxPerHour')
    expect(got).not.toHaveProperty('triggerLogRetentionDays')
    await r.app.request('/settings', json('PATCH', { teamName: 'Still me' }))
    const row = r.server.conn.sqlite
      .query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'workspace'")
      .get()
    expect(JSON.parse(row?.value ?? '{}')).toEqual({ teamName: 'Still me' })
  })

  test('a database at migration 0045 keeps every row, gains the new tables and works', async () => {
    const DRIZZLE = new URL('../drizzle', import.meta.url).pathname
    const journal = JSON.parse(readFileSync(join(DRIZZLE, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>
      [k: string]: unknown
    }
    const before = journal.entries.filter((e) => e.idx <= 45)
    expect(journal.entries.at(-1)?.tag).toBe('0046_events_triggers')
    const tmp = mkdtempSync(join(tmpdir(), 'team-oldmig-'))
    dirs.push(tmp)
    mkdirSync(join(tmp, 'meta'))
    for (const e of before) cpSync(join(DRIZZLE, `${e.tag}.sql`), join(tmp, `${e.tag}.sql`))
    writeFileSync(join(tmp, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: before }))
    const dir = mkdtempSync(join(tmpdir(), 'team-upgrade-'))
    dirs.push(dir)
    const file = join(dir, 'team.db')
    const old = new Database(file, { create: true, strict: true })
    old.run('PRAGMA journal_mode = WAL')
    migrate(drizzle({ client: old }), { migrationsFolder: tmp })
    const tables = (db: Database): string[] =>
      db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((t) => t.name)
    expect(tables(old)).not.toContain('triggers')
    // rows of tables the feature touches or sits next to
    old
      .query("INSERT INTO settings (key, value, updated_at) VALUES ('workspace', ?, 1)")
      .run(JSON.stringify({ teamName: 'Keep me' }))
    old
      .query('INSERT INTO events (type, payload, created_at) VALUES (?, ?, ?)')
      .run('settings-changed', '{"keys":["teamName"]}', Date.now())
    old
      .query(
        `INSERT INTO ch_events (id, connection_id, type, at, received_at, dedupe_key, payload)
         VALUES ('e1', 'c1', 'member.joined', ?, ?, 'k1', '{}')`,
      )
      .run(Date.now(), Date.now())
    old
      .query(
        `INSERT INTO notifications (id, kind, key, title, body, created_at) VALUES ('n1', 'alert', 'k', 'Old', 'Body', 1)`,
      )
      .run()
    const counts = (db: Database): Record<string, number> =>
      Object.fromEntries(
        ['settings', 'events', 'ch_events', 'notifications', 'agents'].map((t) => [
          t,
          db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${t}`).get()?.n ?? 0,
        ]),
      )
    const was = counts(old)
    old.close()

    const conn = openDatabase(file)
    expect(counts(conn.sqlite)).toEqual(was)
    expect(tables(conn.sqlite)).toEqual(
      expect.arrayContaining(['triggers', 'trigger_fires', 'ch_join_requests']),
    )
    expect(
      conn.sqlite.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM triggers').get()?.n,
    ).toBe(0)
    conn.close()

    // and the whole server boots on it, still seeing the old rows through the new views
    const r = instance({}, dir)
    const page = await events(r, '?type=member.joined')
    expect(page.items.map((e) => e.id)).toContain('ch:e1')
    expect((await events(r, '?source=app')).items.some((e) => e.type === 'settings.changed')).toBe(
      true,
    )
    expect(r.server.deps.settings.get().teamName).toBe('Keep me')
  })
})
