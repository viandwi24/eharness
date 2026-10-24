/**
 * The event stream and the triggers, end to end on the composed server: one query over chat events
 * and app events (filters, paging), join requests as events, every action of a trigger (wake an
 * agent, run a program, notify the owner, a signed webhook), the safety rules (cooldown, the hourly
 * cap, the agent's own doing, Pause all, who may change a trigger), the firing log, the dry run, the
 * agent tools, and an upgrade from the database before these tables.
 */
import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { webCryptoVault } from 'eharness/providers'
import { type ScriptedModel, type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { updateAgent } from '../src/app/agents.ts'
import { raiseAlarm } from '../src/app/alarms.ts'
import { createTrigger, mayManageTriggers } from '../src/app/triggers.ts'
import type { StreamEvent } from '../src/domain/event-stream.ts'
import type { Trigger, TriggerFire } from '../src/domain/triggers.ts'
import { createMockAdapter, type MockAdapter } from '../src/infra/channels/index.ts'
import { openDatabase } from '../src/infra/db/client.ts'
import type { ModelConfig } from '../src/infra/eh/provider.ts'
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

interface WebhookCall {
  url: string
  headers: Record<string, string>
  body: string
}
const CHAT = '-1001'
const SECRET = 'a-webhook-secret-of-16+'

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
  const hook = {
    calls: [] as WebhookCall[],
    answers: [200] as Array<number | 'hang'>,
    resolves: ['93.184.216.34'],
  }
  let n = 0
  const fetcher = (async (url: string, init: RequestInit) => {
    hook.calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: String(init.body),
    })
    const answer = hook.answers[Math.min(n++, hook.answers.length - 1)]
    if (answer === 'hang')
      return new Promise((_r, reject) =>
        init.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
      )
    return new Response(null, { status: answer as number })
  }) as unknown as typeof fetch
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
    triggers: {
      webhook: {
        fetch: fetcher,
        resolveHost: async () => hook.resolves,
        timeoutMs: 60,
        backoffMs: [1, 1],
        sleep: async () => undefined,
      },
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
  return { server, app: server.app, models, hook, ids, dir }
}
type Rig = ReturnType<typeof instance>

const joiner = { id: '55', name: 'Zed', username: 'zed' }
const room = {
  nativeId: CHAT,
  kind: 'room' as const,
  title: 'Ops',
  traits: { multiUser: true, threading: 'relation' as const },
}

async function connect(r: Rig): Promise<MockAdapter> {
  const gw = r.server.channels
  gw.configure({
    connectionId: 'c1',
    agentId: r.ids.lead as string,
    rate: { chatMinIntervalMs: 0 },
    people: { defaultRole: 'guest', policy: {} },
  })
  const node = gw.settings.ensureNode('c1', { nativeId: CHAT, kind: 'room', title: 'Ops' })
  gw.settings.set(node.id, { enabled: true, label: 'Ops', ack: false } as never)
  const mock = createMockAdapter({ connectionId: 'c1' })
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
const selfIdentity = { id: 'c1-bot', name: 'Bot', isSelf: true }

interface Page {
  items: StreamEvent[]
  next?: string
}
const events = async (r: Rig, query = ''): Promise<Page> =>
  (await (await r.app.request(`/events${query}`)).json()) as Page

async function addTrigger(r: Rig, body: Record<string, unknown>): Promise<Trigger> {
  const res = await r.app.request('/triggers', json('POST', body))
  if (res.status !== 201) throw new Error(await res.text())
  return (await res.json()) as Trigger
}
const fires = async (r: Rig, id: string): Promise<TriggerFire[]> =>
  (
    (await (await r.app.request(`/triggers/${id}/fires`)).json()) as {
      items: TriggerFire[]
    }
  ).items
const executed = (list: TriggerFire[]): TriggerFire[] => list.filter((f) => f.result !== 'skipped')

const notifyOn = (name: string, types: string[], extra: Record<string, unknown> = {}) => ({
  name,
  eventTypes: types,
  action: { kind: 'notify' },
  ...extra,
})

const wire = (m: ScriptedModel | undefined): string => JSON.stringify(m?.prompts ?? [])
/** The bell notifications triggers made (the rig has others of its own). */
const bells = (r: Rig) =>
  r.server.deps.notifications
    .list({ open: true, limit: 50 })
    .filter((n) => n.link?.startsWith('/events?e=') === true)

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

  test('the catalog says what a bot and an account deliver', async () => {
    const r = instance()
    const res = await r.app.request('/events/catalog')
    const catalog = (await res.json()) as {
      types: Array<{ type: string; delivery?: { bot: string; account: string } }>
    }
    const deleted = catalog.types.find((t) => t.type === 'message.deleted')
    expect(deleted?.delivery?.bot).toContain('does not report deletions')
    expect(
      catalog.types.find((t) => t.type === 'member.join_requested')?.delivery?.account,
    ).toContain('administrator')
    expect(catalog.types.some((t) => t.type === 'alarm.raised')).toBe(true)
  })

  test("an event of a session a trigger started is the agent's own", async () => {
    const r = instance()
    r.server.conn.sqlite
      .query(
        `INSERT INTO trigger_fires (id, trigger_id, event_id, event_type, at, result, action_kind, duration_ms, detail)
         VALUES ('f1', 't1', 'ch:x', 'member.joined', 1, 'ok', 'wake', 0, ?)`,
      )
      .run(JSON.stringify({ sessionId: 'dm:woken' }))
    r.server.deps.events.append({
      type: 'task-changed',
      sessionId: 'dm:woken',
      payload: { taskId: 't', status: 'done', title: 'x' },
    })
    r.server.deps.events.append({
      type: 'task-changed',
      sessionId: 'dm:other',
      payload: { taskId: 't2', status: 'done', title: 'y' },
    })
    const items = (await events(r, '?type=task.changed')).items
    expect(items.find((e) => e.sessionId === 'dm:woken')?.agentCaused).toBe(true)
    expect(items.find((e) => e.sessionId === 'dm:other')?.agentCaused).toBe(false)
  })
})

// --- creating triggers ---------------------------------------------------------------------------

describe('triggers: the API and who may change them', () => {
  test('create, read, edit, switch, delete; bad input is a readable 400', async () => {
    const r = instance()
    const t = await addTrigger(r, notifyOn('Alarms', ['alarm.raised'], { cooldownSec: 30 }))
    expect(t).toMatchObject({
      name: 'Alarms',
      enabled: true,
      cooldownSec: 30,
      createdBy: 'web owner',
      fireCount: 0,
      hasSecret: false,
    })
    const list = (await (await r.app.request('/triggers')).json()) as {
      items: Trigger[]
      hourlyCap: number
    }
    expect(list.items).toHaveLength(1)
    expect(list.hourlyCap).toBe(60)
    const patched = (await (
      await r.app.request(`/triggers/${t.id}`, json('PATCH', { name: 'Alarm bell', notes: 'why' }))
    ).json()) as Trigger
    expect(patched).toMatchObject({
      name: 'Alarm bell',
      notes: 'why',
      eventTypes: ['alarm.raised'],
    })
    const off = (await (
      await r.app.request(`/triggers/${t.id}`, json('PATCH', { enabled: false }))
    ).json()) as Trigger
    expect(off.enabled).toBe(false)

    const bad = await r.app.request(
      '/triggers',
      json('POST', {
        name: 'x',
        eventTypes: ['message.created'],
        filters: { textRegex: '(a+)+$' },
        action: { kind: 'notify' },
      }),
    )
    expect(bad.status).toBe(400)
    expect(JSON.stringify(await bad.json())).toContain('can run for ever')
    const missing = await r.app.request(
      '/triggers',
      json('POST', {
        name: 'x',
        eventTypes: ['alarm.raised'],
        action: { kind: 'wake', agentId: 'nobody', target: 'thread', instruction: 'y' },
      }),
    )
    expect(missing.status).toBe(400)
    expect((await r.app.request('/triggers/unknown')).status).toBe(404)
    expect((await r.app.request(`/triggers/${t.id}`, { method: 'DELETE' })).status).toBe(204)
    expect(
      ((await (await r.app.request('/triggers')).json()) as { items: Trigger[] }).items,
    ).toEqual([])
  })

  test('a webhook needs a secret (sealed, never returned) and a public host', async () => {
    const r = instance()
    const hook = (extra: Record<string, unknown>) => ({
      name: 'Hook',
      eventTypes: ['alarm.raised'],
      action: { kind: 'webhook', url: 'https://example.com/h' },
      ...extra,
    })
    expect((await r.app.request('/triggers', json('POST', hook({})))).status).toBe(400)
    const private_ = await r.app.request(
      '/triggers',
      json(
        'POST',
        hook({ action: { kind: 'webhook', url: 'https://127.0.0.1/h' }, webhookSecret: SECRET }),
      ),
    )
    expect(private_.status).toBe(400)
    expect(JSON.stringify(await private_.json())).toContain('private')
    r.hook.resolves = ['10.0.0.9']
    expect(
      (await r.app.request('/triggers', json('POST', hook({ webhookSecret: SECRET })))).status,
    ).toBe(400)
    r.hook.resolves = ['93.184.216.34']
    const t = await addTrigger(r, hook({ webhookSecret: SECRET }))
    expect(t.hasSecret).toBe(true)
    expect(JSON.stringify(t)).not.toContain(SECRET)
    const stored = r.server.conn.sqlite
      .query<{ webhook_secret: string }, [string]>(
        'SELECT webhook_secret FROM triggers WHERE id = ?',
      )
      .get(t.id)?.webhook_secret
    expect(stored).toBeDefined()
    expect(stored).not.toContain(SECRET)
    // changing the action away from a webhook forgets the secret
    const moved = (await (
      await r.app.request(`/triggers/${t.id}`, json('PATCH', { action: { kind: 'notify' } }))
    ).json()) as Trigger
    expect(moved.hasSecret).toBe(false)
  })

  test('only the owner and the admins of the team may change triggers', async () => {
    const r = instance()
    const input = {
      name: 'By chat',
      eventTypes: ['alarm.raised'],
      action: { kind: 'notify' as const },
    }
    expect(mayManageTriggers({ kind: 'web' })).toBe(true)
    expect(mayManageTriggers({ kind: 'chat', role: 'owner', name: 'O' })).toBe(true)
    expect(mayManageTriggers({ kind: 'chat', role: 'admin', name: 'A' })).toBe(true)
    expect(mayManageTriggers({ kind: 'chat', role: 'member', name: 'M' })).toBe(false)
    expect(mayManageTriggers({ kind: 'chat', role: 'guest', name: 'G' })).toBe(false)
    await expect(
      createTrigger(r.server.deps, { kind: 'chat', role: 'member', name: 'Mia' }, input),
    ).rejects.toThrow(/Only the owner or an admin/)
    const t = await createTrigger(
      r.server.deps,
      { kind: 'chat', role: 'admin', name: 'Ana' },
      input,
    )
    expect(t.createdBy).toBe('Ana (admin)')
  })
})

// --- the actions ---------------------------------------------------------------------------------

describe('wake an agent', () => {
  test('a join request starts a turn in the Triggers thread with the formatted event', async () => {
    const r = instance({ lead: [{ text: 'I checked the person.' }] })
    await connect(r)
    const t = await addTrigger(r, {
      name: 'New joiners',
      eventTypes: ['member.join_requested'],
      scope: { chatIds: [r.server.channels.nodes.byNative('c1', CHAT)?.id] },
      action: {
        kind: 'wake',
        agentId: r.ids.lead,
        target: 'triggers',
        instruction: 'Check the person in People; approve active members, else ask the owner.',
      },
    })
    await joinRequest(r)
    await until('a turn started', () => (r.models.lead?.prompts.length ?? 0) === 1)
    const text = wire(r.models.lead)
    expect(text).toContain('A trigger fired: \\"New joiners\\"')
    expect(text).toContain('Instruction: Check the person in People')
    expect(text).toContain('member.join_requested')
    expect(text).toContain('connection=c1')
    expect(text).toContain('chat=-1001')
    expect(text).toContain('user=55')
    expect(text).toContain('Zed @zed')
    expect(text).toContain('link=https://t.me/+xyz')
    await until('logged', async () => executed(await fires(r, t.id)).length === 1)
    const fire = executed(await fires(r, t.id))[0] as TriggerFire
    expect(fire).toMatchObject({
      result: 'ok',
      actionKind: 'wake',
      eventType: 'member.join_requested',
    })
    expect(fire.eventId).toMatch(/^ch:/)
    expect(typeof fire.detail.sessionId).toBe('string')
    const threads = r.server.deps.threads.list(r.ids.lead as string)
    const triggers = threads.find((x) => x.title === 'Triggers')
    expect(triggers?.sessionId).toBe(String(fire.detail.sessionId))
    const row = (await (await r.app.request(`/triggers/${t.id}`)).json()) as Trigger
    expect(row).toMatchObject({ fireCount: 1, errorCount: 0 })
    expect(row.lastFiredAt).toBe(fire.at)
  })

  test('target chat wakes the session of the chat; the message text goes along only when asked', async () => {
    const r = instance({ lead: [{ text: 'ok' }] })
    const mock = await connect(r)
    const t = await addTrigger(r, {
      name: 'Invoices',
      eventTypes: ['message.created'],
      filters: { textContains: ['invoice'] },
      action: {
        kind: 'wake',
        agentId: r.ids.lead,
        target: 'chat',
        instruction: 'Tell the owner about invoice talk.',
        includeText: true,
      },
    })
    await mock.say({ chat: CHAT, kind: 'group', from: joiner, text: 'nothing special here' })
    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: joiner,
      text: 'please send the INVOICE for May',
    })
    await until('turn', () => (r.models.lead?.prompts.length ?? 0) >= 1)
    const text = wire(r.models.lead)
    expect(text).toContain('A trigger fired')
    expect(text).toContain('Message text (data written by a person')
    expect(text).toContain('please send the INVOICE for May')
    // the message the trigger woke the agent with is the last one; the other message is only chat context
    const last = r.models.lead?.prompts.at(-1) as unknown as Array<{ content: unknown }>
    expect(JSON.stringify(last.at(-1))).not.toContain('nothing special here')
    await until('logged', async () => executed(await fires(r, t.id)).length === 1)
    const fire = executed(await fires(r, t.id))[0] as TriggerFire
    const room = r.server.channels.nodes.byNative('c1', CHAT)
    expect(fire.detail.sessionId).toBe(
      r.server.channels.sessions.get('c1', room?.id as string)?.sessionId,
    )
    // the log never holds the text
    expect(JSON.stringify(fire)).not.toContain('INVOICE')
    // a message that does not match is counted, not logged
    expect((await fires(r, t.id)).filter((f) => f.reason === 'filtered')).toHaveLength(0)
    const view = (await (await r.app.request(`/triggers/${t.id}`)).json()) as Trigger & {
      filteredCount: number
    }
    expect(view.filteredCount).toBeGreaterThanOrEqual(1)
  })
})

describe('run a program', () => {
  test('an alarm about a program runs another program with the event as context', async () => {
    const r = instance({
      researcher: [
        {
          toolCalls: [
            {
              toolName: 'final_answer',
              input: { status: 'done', summary: 'handled', outputs: [] },
            },
          ],
        },
      ],
    })
    const created = await r.app.request(
      '/programs',
      json('POST', {
        agentId: 'researcher',
        name: 'Recover',
        brief: 'Look at what failed and fix what you can.',
        authority: { read: ['/library/**'], write: [] },
        gates: [],
        escalation: 'Stop when unsure.',
        forbidden: [],
        budget: { perRunUsd: null, perDayUsd: null },
      }),
    )
    expect(created.status).toBe(201)
    const program = (await created.json()) as { id: string }
    const t = await addTrigger(r, {
      name: 'Recover on failure',
      eventTypes: ['alarm.raised'],
      filters: { fields: [{ field: 'kind', equals: 'run-failed' }] },
      action: { kind: 'program', programId: program.id },
    })
    raiseAlarm(r.server.deps, {
      kind: 'system',
      key: 'a1',
      subject: 'system:x',
      text: 'Not this one.',
    })
    raiseAlarm(r.server.deps, {
      kind: 'run-failed',
      key: 'a2',
      subject: 'system:y',
      text: 'The import failed. Look.',
    })
    await until('program run', async () => executed(await fires(r, t.id)).length === 1)
    const fire = executed(await fires(r, t.id))[0] as TriggerFire
    expect(fire).toMatchObject({ result: 'ok', actionKind: 'program' })
    expect(fire.detail.sessionId).toMatch(/^program:/)
    await until('prompt', () => (r.models.researcher?.prompts.length ?? 0) >= 1)
    const text = wire(r.models.researcher)
    expect(text).toContain('What started this run')
    expect(text).toContain('alarm.raised')
    expect(text).toContain('The import failed')
    expect(text).not.toContain('Not this one')
  })

  test('a program that is still running makes the next firing a skip (busy), not an error', async () => {
    const r = instance({ researcher: [{ text: 'x', delayMs: 800 } as never] })
    const created = await r.app.request(
      '/programs',
      json('POST', {
        agentId: 'researcher',
        name: 'Slow',
        brief: 'Take your time.',
        authority: { read: ['/library/**'], write: [] },
        gates: [],
        escalation: 'x',
        forbidden: [],
        budget: { perRunUsd: null, perDayUsd: null },
      }),
    )
    const program = (await created.json()) as { id: string }
    const t = await addTrigger(r, notifyOn('Slow', ['alarm.raised']))
    await r.app.request(
      `/triggers/${t.id}`,
      json('PATCH', { action: { kind: 'program', programId: program.id } }),
    )
    raiseAlarm(r.server.deps, { kind: 'system', key: 'b1', subject: 's1', text: 'One.' })
    await until('first', async () => (await fires(r, t.id)).length >= 1)
    raiseAlarm(r.server.deps, { kind: 'system', key: 'b2', subject: 's2', text: 'Two.' })
    await until('second', async () => (await fires(r, t.id)).length >= 2)
    const list = await fires(r, t.id)
    expect(list.map((f) => `${f.result}:${f.reason ?? ''}`).sort()).toEqual(['ok:', 'skipped:busy'])
  })
})

describe('notify the owner', () => {
  test('a bell notification that links to the event, and the direct chat path when asked', async () => {
    const r = instance()
    await connect(r)
    const t = await addTrigger(r, {
      name: 'Tell me',
      eventTypes: ['member.join_requested'],
      action: { kind: 'notify', dm: true, title: 'Somebody wants in' },
    })
    await joinRequest(r)
    await until('fired', async () => executed(await fires(r, t.id)).length === 1)
    const bell = bells(r)
    expect(bell).toHaveLength(1)
    expect(bell[0]).toMatchObject({ title: 'Somebody wants in', kind: 'alert' })
    expect(bell[0]?.body).toContain('Zed @zed asked to join')
    expect(bell[0]?.link).toMatch(/^\/events\?e=ch%3A/)
    const fire = executed(await fires(r, t.id))[0] as TriggerFire
    // no owner is linked to a chat in this rig: the direct message could not be sent, the bell did
    expect(fire.detail).toMatchObject({ bell: true, dm: 'unavailable' })
  })
})

describe('call a webhook', () => {
  const hookBody = (events: string[] = ['member.join_requested']) => ({
    name: 'To the CRM',
    eventTypes: events,
    action: { kind: 'webhook', url: 'https://example.com/hooks/team' },
    webhookSecret: SECRET,
  })

  test('one signed POST with facts of the event, never message text', async () => {
    const r = instance()
    await connect(r)
    const t = await addTrigger(r, hookBody())
    await joinRequest(r)
    await until('sent', () => r.hook.calls.length === 1)
    const call = r.hook.calls[0] as WebhookCall
    expect(call.url).toBe('https://example.com/hooks/team')
    const expected = `sha256=${createHmac('sha256', SECRET).update(`${call.headers['x-team-timestamp']}.${call.body}`).digest('hex')}`
    expect(call.headers['x-team-signature']).toBe(expected)
    expect(call.headers['x-team-event']).toBe('member.join_requested')
    const body = JSON.parse(call.body) as {
      delivery: string
      trigger: { id: string }
      event: {
        type: string
        actor: { id: string; role: string }
        chat: { id: string }
        fields: { link: string }
      }
    }
    expect(body.trigger.id).toBe(t.id)
    expect(body.event).toMatchObject({
      type: 'member.join_requested',
      actor: { id: '55' },
      chat: { id: CHAT },
    })
    expect(body.event.fields.link).toBe('https://t.me/+xyz')
    await until('logged', async () => executed(await fires(r, t.id)).length === 1)
    const fire = executed(await fires(r, t.id))[0] as TriggerFire
    expect(fire).toMatchObject({
      result: 'ok',
      actionKind: 'webhook',
      detail: { status: 200, attempts: 1 },
    })
    expect(call.headers['x-team-delivery']).toBe(body.delivery)
    expect(JSON.stringify(fire)).not.toContain(SECRET)
  })

  test('a failing receiver is retried a little, then the firing is an error with the status', async () => {
    const r = instance()
    await connect(r)
    r.hook.answers = [500]
    const t = await addTrigger(r, hookBody())
    await joinRequest(r)
    await until('error logged', async () => executed(await fires(r, t.id)).length === 1)
    const fire = executed(await fires(r, t.id))[0] as TriggerFire
    expect(fire).toMatchObject({
      result: 'error',
      reason: 'status',
      detail: { status: 500, attempts: 3 },
    })
    expect(r.hook.calls).toHaveLength(3)
    const row = (await (await r.app.request(`/triggers/${t.id}`)).json()) as Trigger
    expect(row.errorCount).toBe(1)
  })

  test('a receiver that hangs times out; a host that turned private is refused at send time', async () => {
    const r = instance()
    await connect(r)
    r.hook.answers = ['hang']
    const t = await addTrigger(r, hookBody())
    await joinRequest(r)
    await until('timeout logged', async () => executed(await fires(r, t.id)).length === 1)
    expect(executed(await fires(r, t.id))[0]).toMatchObject({ result: 'error', reason: 'timeout' })

    // the name now resolves to a private address: no request leaves
    r.hook.resolves = ['10.9.9.9']
    const before = r.hook.calls.length
    await joinRequest(r, { id: '56', name: 'Yan' })
    await until('blocked logged', async () => executed(await fires(r, t.id)).length === 2)
    expect(executed(await fires(r, t.id))[0]).toMatchObject({ result: 'error', reason: 'blocked' })
    expect(r.hook.calls.length).toBe(before)
  })
})

// --- safety --------------------------------------------------------------------------------------

describe('safety', () => {
  test('a cooldown skips the next firing (logged once a minute), then it fires again', async () => {
    const r = instance()
    await connect(r)
    const t = await addTrigger(
      r,
      notifyOn('Joins', ['member.join_requested'], { cooldownSec: 3600 }),
    )
    await joinRequest(r, { id: '60', name: 'A' })
    await until('first', async () => executed(await fires(r, t.id)).length === 1)
    await joinRequest(r, { id: '61', name: 'B' })
    await joinRequest(r, { id: '62', name: 'C' })
    await until('skip row', async () => (await fires(r, t.id)).some((f) => f.reason === 'cooldown'))
    const list = await fires(r, t.id)
    expect(list.filter((f) => f.reason === 'cooldown')).toHaveLength(1)
    expect(executed(list)).toHaveLength(1)
    expect(bells(r)).toHaveLength(1)
    // the cooldown is over (the stored time moves back)
    r.server.conn.sqlite
      .query('UPDATE triggers SET last_fired_at = ? WHERE id = ?')
      .run(Date.now() - 4_000_000, t.id)
    await joinRequest(r, { id: '63', name: 'D' })
    await until('fires again', async () => executed(await fires(r, t.id)).length === 2)
  })

  test('the hourly cap in Settings stops every trigger together', async () => {
    const r = instance()
    await connect(r)
    await r.app.request('/settings', json('PATCH', { triggersMaxPerHour: 1 }))
    const a = await addTrigger(r, notifyOn('A', ['member.join_requested']))
    const b = await addTrigger(r, notifyOn('B', ['member.join_requested']))
    await joinRequest(r)
    await until(
      'two rows',
      async () => (await fires(r, a.id)).length + (await fires(r, b.id)).length >= 2,
    )
    const rows = [...(await fires(r, a.id)), ...(await fires(r, b.id))]
    expect(executed(rows)).toHaveLength(1)
    expect(rows.filter((f) => f.reason === 'cap')).toHaveLength(1)
    // 0 means no cap
    await r.app.request('/settings', json('PATCH', { triggersMaxPerHour: 0 }))
    await joinRequest(r, { id: '77', name: 'N' })
    await until(
      'both fire',
      async () => executed([...(await fires(r, a.id)), ...(await fires(r, b.id))]).length >= 3,
    )
  })

  test("the agent's own doing does not fire a trigger unless it is allowed", async () => {
    const r = instance()
    await connect(r)
    const plain = await addTrigger(r, notifyOn('Own words', ['message.created']))
    const loud = await addTrigger(
      r,
      notifyOn('Own words allowed', ['message.created'], { allowSelf: true }),
    )
    const members = await addTrigger(r, notifyOn('Member changes', ['member.joined']))
    const memberLoud = await addTrigger(
      r,
      notifyOn('Member changes allowed', ['member.joined'], { allowSelf: true }),
    )
    await r.server.channels.handle('c1', {
      type: 'message.created',
      dedupeKey: 'self-1',
      at: Date.now(),
      node: { nativeId: CHAT, chain: [room] },
      actor: selfIdentity,
      message: {
        nativeId: '900',
        sender: selfIdentity,
        text: 'I answered',
        attachments: [],
        direction: 'out',
      },
      signals: { mentionedSelf: false, replyToSelf: false },
    })
    // the agent added somebody (the change was made by this connection)
    await r.server.channels.handle('c1', {
      type: 'member.joined',
      dedupeKey: 'self-2',
      at: Date.now(),
      node: { nativeId: CHAT, chain: [room] },
      actor: joiner,
      by: selfIdentity,
      role: 'member',
    })
    await until(
      'rows',
      async () =>
        executed(await fires(r, loud.id)).length === 1 &&
        executed(await fires(r, memberLoud.id)).length === 1,
    )
    // messages: counted, not logged; member changes: a skip row with the reason
    expect(await fires(r, plain.id)).toHaveLength(0)
    expect((await fires(r, members.id))[0]).toMatchObject({ result: 'skipped', reason: 'loop' })
    expect(executed(await fires(r, members.id))).toHaveLength(0)
    const view = (await (await r.app.request(`/triggers/${plain.id}`)).json()) as {
      filteredCount: number
    }
    expect(view.filteredCount).toBe(1)
    const msg = (await events(r, '?type=message.created')).items[0] as StreamEvent
    expect(msg.agentCaused).toBe(true)
    expect(msg.actor?.self).toBe(true)
    const joined = (await events(r, '?type=member.joined')).items[0] as StreamEvent
    expect(joined).toMatchObject({ agentCaused: true, fields: { bySelf: 'true' } })
  })

  test('Pause all holds triggers (recorded as paused, not replayed) until Resume', async () => {
    const r = instance()
    await connect(r)
    const t = await addTrigger(r, notifyOn('Joins', ['member.join_requested']))
    await r.app.request('/workspace/pause', json('POST', { note: 'deploy' }))
    await joinRequest(r)
    await until('skip', async () => (await fires(r, t.id)).length === 1)
    expect((await fires(r, t.id))[0]).toMatchObject({ result: 'skipped', reason: 'paused' })
    expect(bells(r)).toHaveLength(0)
    await r.app.request('/workspace/resume', json('POST'))
    await sleep(100)
    expect(executed(await fires(r, t.id))).toHaveLength(0)
    await joinRequest(r, { id: '88', name: 'Later' })
    await until('fires after resume', async () => executed(await fires(r, t.id)).length === 1)
  })

  test('events from before a restart catch-up are ignored; a disabled trigger does nothing', async () => {
    const r = instance()
    await connect(r)
    const t = await addTrigger(r, notifyOn('Joins', ['member.join_requested']))
    await joinRequest(r, { id: '90', name: 'Old' }, Date.now() - 2 * 3_600_000)
    // join requests are noticed up to a day late; an old message-like event is not
    await until('old join request fires', async () => executed(await fires(r, t.id)).length === 1)
    const m = await addTrigger(r, notifyOn('Msgs', ['message.created']))
    await r.server.channels.handle('c1', {
      type: 'message.created',
      dedupeKey: 'old-msg',
      at: Date.now() - 3_600_000,
      node: { nativeId: CHAT, chain: [room] },
      actor: joiner,
      message: { nativeId: '5', sender: joiner, text: 'old', attachments: [] },
      signals: { mentionedSelf: false, replyToSelf: false },
    })
    await sleep(150)
    expect(await fires(r, m.id)).toHaveLength(0)
    await r.app.request(`/triggers/${t.id}`, json('PATCH', { enabled: false }))
    await joinRequest(r, { id: '91', name: 'New' })
    await sleep(150)
    expect(executed(await fires(r, t.id))).toHaveLength(1)
  })

  test('the firing log is pruned by the retention setting', async () => {
    const r = instance()
    const t = await addTrigger(r, notifyOn('Joins', ['member.join_requested']))
    const old = Date.now() - 40 * 86_400_000
    for (const [id, at] of [
      ['f-old', old],
      ['f-new', Date.now()],
    ] as const) {
      r.server.conn.sqlite
        .query(
          `INSERT INTO trigger_fires (id, trigger_id, event_id, event_type, at, result, action_kind, duration_ms, detail)
           VALUES (?, ?, 'ch:x', 'member.joined', ?, 'ok', 'notify', 0, '{}')`,
        )
        .run(id, t.id, at)
    }
    expect(r.server.triggerEngine.prune()).toBe(1)
    expect((await fires(r, t.id)).map((f) => f.id)).toEqual(['f-new'])
    // 0 keeps everything
    await r.app.request('/settings', json('PATCH', { triggerLogRetentionDays: 0 }))
    expect(r.server.triggerEngine.prune()).toBe(0)
  })
})

// --- the dry run ---------------------------------------------------------------------------------

describe('the dry run', () => {
  test('shows what would happen and does nothing; says why not for another event and for a pause', async () => {
    const r = instance({ lead: [{ text: 'never' }] })
    await connect(r)
    await joinRequest(r)
    const joinEventId = (await events(r, '?type=member.join_requested')).items[0]?.id as string
    const t = await addTrigger(r, {
      name: 'Joiners',
      eventTypes: ['member.join_requested'],
      filters: { actorRoles: ['guest'] },
      action: {
        kind: 'wake',
        agentId: r.ids.lead,
        target: 'triggers',
        instruction: 'Check the joiner.',
      },
    })
    await sleep(80)
    const before = (await fires(r, t.id)).length
    const test = async (eventId: string) =>
      (await (await r.app.request(`/triggers/${t.id}/test`, json('POST', { eventId }))).json()) as {
        verdict: string
        reason?: string
        summary: string
        wouldDo: string[]
        problems: string[]
        notes: string[]
      }
    const ok = await test(joinEventId)
    expect(ok.verdict).toBe('fire')
    expect(ok.wouldDo.join('\n')).toContain('Instruction: Check the joiner.')
    expect(ok.wouldDo.join('\n')).toContain('user=55')
    expect(ok.problems).toEqual([])

    await r.app.request('/workspace/pause', json('POST', {}))
    expect(await test(joinEventId)).toMatchObject({ verdict: 'skip', reason: 'paused' })
    await r.app.request('/workspace/resume', json('POST'))

    r.server.channels.people.setRole('c1', joiner.id, { role: 'admin' }, 'owner')
    expect(await test(joinEventId)).toMatchObject({ verdict: 'nomatch', reason: 'filtered' })

    const alarmEvent = (() => {
      raiseAlarm(r.server.deps, { kind: 'system', key: 'dry', subject: 's', text: 'x' })
      return events(r, '?type=alarm.raised')
    })()
    expect(await test((await alarmEvent).items[0]?.id as string)).toMatchObject({
      verdict: 'nomatch',
      reason: 'type',
    })

    // nothing ran: no turn, no firing rows
    expect(r.models.lead?.prompts.length ?? 0).toBe(0)
    expect((await fires(r, t.id)).length).toBe(before)
    expect(
      (await r.app.request(`/triggers/${t.id}/test`, json('POST', { eventId: 'ch:none' }))).status,
    ).toBe(404)
  })

  test('a text filter on a past event is skipped with a note, and an action that cannot work is a problem', async () => {
    const r = instance()
    const mock = await connect(r)
    await mock.say({ chat: CHAT, kind: 'group', from: joiner, text: 'hello' })
    const id = (await events(r, '?type=message.created')).items[0]?.id as string
    const t = await addTrigger(r, {
      name: 'Words',
      eventTypes: ['message.created'],
      filters: { textContains: ['refund'] },
      action: { kind: 'wake', agentId: r.ids.researcher, target: 'thread', instruction: 'Look.' },
    })
    await r.app.request(`/agents/${r.ids.researcher}`, { method: 'DELETE' })
    const res = (await (
      await r.app.request(`/triggers/${t.id}/test`, json('POST', { eventId: id }))
    ).json()) as {
      verdict: string
      notes: string[]
      problems: string[]
    }
    expect(res.notes.join(' ')).toContain('not stored')
    expect(res.verdict).toBe('fire')
    expect(res.problems.join(' ')).toContain('gone or archived')
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
const call = (input: Record<string, unknown>, tool = 'triggers'): ScriptedStepInput => ({
  toolCalls: [{ toolName: tool, input }],
})
async function chat(r: Rig, slug: string, text: string): Promise<void> {
  const id = r.ids[slug] as string
  const res = await r.app.request(`/sessions/dm:${id}/chat`, postAs(`dm:${id}`, userMessage(text)))
  expect(res.status).toBe(200)
  await res.text()
}

describe('the agent tools', () => {
  test('the owner asks in the web chat: the agent creates, lists, tests, switches and deletes; every answer is plain lines', async () => {
    const r = instance({
      lead: [
        call({
          action: 'create',
          name: 'New joiners',
          events: ['member.join_requested'],
          chats: ['Ops'],
          roles: ['guest'],
          do: 'wake',
          target: 'triggers',
          instruction:
            'Check the person in People; approve active members, otherwise ask the owner.',
          cooldownSeconds: 5,
        }),
        { text: 'Created.' },
        call({ action: 'list' }),
        { text: 'Listed.' },
      ],
    })
    await connect(r)
    await chat(r, 'lead', 'When somebody asks to join Ops, check them and approve active members.')
    const made = results(r.models.lead)[0] as string
    expect(made).toContain('Created trigger')
    expect(made).toContain('"New joiners"')
    expect(made).toContain('on member.join_requested')
    expect(made).toContain('scope chat "Ops"')
    expect(made).toContain('filters actor role guest')
    expect(made).not.toMatch(/[{]\s*"/)
    const stored = r.server.deps.triggers.list()
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({
      createdBy: 'web owner',
      cooldownSec: 5,
      scope: { chatIds: [r.server.channels.nodes.byNative('c1', CHAT)?.id] },
    })
    await chat(r, 'lead', 'what triggers do we have?')
    const listed = results(r.models.lead).find((x) => x.includes('trigger(s)')) as string
    expect(listed).toContain('1 trigger(s); 0 firing(s) in the last hour of at most 60')
    expect(listed.split('\n')).toHaveLength(2)
  })

  test('test, enable, disable, update, log and delete work on a trigger by name; a webhook stays off without a secret', async () => {
    const r = instance({
      lead: [
        call({ action: 'disable', trigger: 'joiners' }),
        call({ action: 'update', trigger: 'joiners', cooldownSeconds: 60, name: 'Joiners v2' }),
        call({ action: 'enable', trigger: 'Joiners v2' }),
        call({ action: 'log', trigger: 'Joiners v2' }),
        call({
          action: 'create',
          name: 'CRM',
          events: ['alarm.raised'],
          do: 'webhook',
          url: 'https://example.com/h',
        }),
        call({ action: 'enable', trigger: 'CRM' }),
        call({ action: 'delete', trigger: 'Joiners v2' }),
        call({ action: 'show', trigger: 'nothing like it' }),
        { text: 'done' },
      ],
    })
    await connect(r)
    await addTrigger(r, notifyOn('Joiners', ['member.join_requested']))
    await chat(r, 'lead', 'manage them')
    const out = results(r.models.lead)
    expect(out.some((x) => x.includes('is now off'))).toBe(true)
    expect(
      out.some(
        (x) =>
          x.startsWith('Updated: ') && x.includes('"Joiners v2"') && x.includes('cooldown 60s'),
      ),
    ).toBe(true)
    expect(out.some((x) => x.includes('is now on'))).toBe(true)
    expect(out.some((x) => x.includes('No firings recorded'))).toBe(true)
    const webhook = out.find(
      (x) => x.includes('Created trigger') && x.includes('POST to'),
    ) as string
    expect(webhook).toContain('switched OFF')
    expect(webhook).toContain('a secret never goes through a chat')
    expect(out.some((x) => x.startsWith('ERROR: this webhook has no secret yet'))).toBe(true)
    expect(out.some((x) => x.startsWith('Deleted trigger "Joiners v2"'))).toBe(true)
    expect(out.some((x) => x.startsWith('ERROR:') && x.includes('trigger not found'))).toBe(true)
    expect(r.server.deps.triggers.list().map((t) => t.name)).toEqual(['CRM'])
    expect(r.server.deps.triggers.list()[0]).toMatchObject({ enabled: false, hasSecret: false })
  })

  test('events_recent answers in lines with the ids to act with, and no message text', async () => {
    const r = instance({
      lead: [
        call({ action: 'events' }),
        call({ types: ['member.join_requested'] }, 'events_recent'),
        { text: 'ok' },
      ],
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
    const catalog = out.find((x) => x.startsWith('Event types a trigger can listen to')) as string
    expect(catalog).toContain('message.deleted')
    expect(catalog).toContain('does not report deletions')
  })

  test('a member in a chat is refused with a sentence, and nothing is created', async () => {
    const r = instance({ lead: [call({ action: 'list' }), { text: 'sorry' }] })
    const mock = await connect(r)
    r.server.channels.people.setRole('c1', joiner.id, { role: 'member' }, 'owner')
    await mock.say({
      chat: CHAT,
      kind: 'group',
      from: joiner,
      text: 'make me a trigger',
      mentionSelf: true,
    })
    await until('answered', () => (r.models.lead?.prompts.length ?? 0) >= 2)
    expect(results(r.models.lead).join('\n')).toContain('Not allowed')
    expect(r.server.deps.triggers.list()).toHaveLength(0)
  })
})

// --- upgrading -----------------------------------------------------------------------------------

describe('upgrading an older database', () => {
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
    const t = await addTrigger(r, notifyOn('After upgrade', ['alarm.raised']))
    expect(t.id).toBeTruthy()
  })
})
