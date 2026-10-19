/**
 * The proactive heartbeat (docs/plans/P51-proactive-and-health.md): standing orders in
 * `HEARTBEAT.md` drive it. A beat runs by itself when there is an order (no order and an empty
 * checklist: no model call), reads the chats of the agent's connections, posts only to the
 * destination of an active order (daily cap per destination, no repeats, through the proactive
 * policy), reports to a web chat through a notice and the bell, wakes early on new messages
 * (debounced, no activity = no model call), and urgent findings reach the bell in a team with no
 * lead. Scripted models and a mock chat adapter only.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webCryptoVault } from 'eharness/providers'
import { type ScriptedModel, type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { createAgent, updateAgent } from '../src/app/agents.ts'
import { planActivityWake } from '../src/app/heartbeat.ts'
import { addOrder } from '../src/app/standing-orders.ts'
import {
  activityLines,
  checklistPath,
  checkPost,
  DIGEST_KEY,
  heartbeatChannelRefusal,
  watchedNodes,
} from '../src/domain/heartbeat.ts'
import { PER_DESTINATION_DAILY_CAP, type StandingOrder } from '../src/domain/standing-orders.ts'
import { createMockAdapter, type MockAdapter } from '../src/infra/channels/index.ts'
import type { ModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'

const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: string, condition: () => boolean | Promise<boolean>, ms = 6000) {
  const end = Date.now() + ms
  while (!(await condition())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await sleep(15)
  }
}
const KEY = new Uint8Array(32).fill(7)
const TUNING = { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 }
const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
let n = 0
const call = (toolName: string, input: Record<string, unknown>): ScriptedStepInput => ({
  toolCalls: [{ toolName, input, toolCallId: `p-${toolName}-${++n}` }],
})
const final = (
  status: 'ok' | 'attention',
  items: Array<{ title: string; urgent?: boolean; kind?: string }> = [],
): ScriptedStepInput =>
  call('final_answer', {
    status,
    items: items.map((i) => ({ kind: 'note', detail: 'detail', links: [], ...i })),
  })
const OK = [call('team_status', {}), final('ok')]

interface Instance {
  server: Server
  app: Server['app']
  model: ScriptedModel
  agentId: string
  slug: string
}

function instance(
  steps: ScriptedStepInput[],
  options: { custom?: boolean; settleMs?: number } = {},
): Instance {
  const dir = mkdtempSync(join(tmpdir(), 'team-hbp-'))
  dirs.push(dir)
  const model = scriptedModel(steps)
  const config: ModelConfig = {
    provider: 'scripted',
    defaultModel: 'none',
    resolve: (id) =>
      id === 'm-agent'
        ? model
        : scriptedModel([
            () => {
              throw new Error(`unexpected model call: ${id}`)
            },
          ]),
  }
  const server = compose({
    dbFile: join(dir, 'team.db'),
    instanceId: 'hbp-test',
    models: config,
    env: {},
    tuning: TUNING,
    eventsPollMs: 30,
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
    heartbeat: { activitySettleMs: options.settleMs ?? 20 },
    ...(options.custom === true ? { seedAgents: false } : {}),
    channels: {
      vault: webCryptoVault(KEY),
      collect: { quietMs: 25, maxWaitMs: 300, maxItems: 20 },
      purgeEveryMs: 0,
      maintenanceMs: 0,
      delivery: { retryBaseMs: 20, retryMaxMs: 80 },
    },
  })
  servers.push(server)
  let agentId: string
  let slug: string
  if (options.custom === true) {
    // a team with no lead: every agent is custom (the production deployment)
    const def = createAgent(server.deps, { name: 'Scout', role: 'custom', instructions: 'x' })
    agentId = def.id
    slug = def.slug
  } else {
    const def = server.deps.agents.getBySlug('lead')
    if (def === undefined) throw new Error('seed missing')
    agentId = def.id
    slug = def.slug
  }
  updateAgent(server.deps, agentId, { model: 'm-agent' })
  return { server, app: server.app, model, agentId, slug }
}

interface Rooms {
  mock: MockAdapter
  community: string
  internal: string
}
/** One connection bound to the agent with a community chat and the internal group (proactive allowed). */
async function connect(i: Instance): Promise<Rooms> {
  const gw = i.server.channels
  gw.configure({
    connectionId: 'c1',
    agentId: i.agentId,
    rate: { chatMinIntervalMs: 0 },
    people: { defaultRole: 'guest', policy: {} },
  })
  const community = gw.settings.ensureNode('c1', {
    nativeId: 'community',
    kind: 'room',
    title: 'Community',
  })
  gw.settings.set(community.id, { enabled: true, ack: false } as never)
  const internal = gw.settings.ensureNode('c1', {
    nativeId: 'internal',
    kind: 'room',
    title: 'Internal',
  })
  gw.settings.set(internal.id, {
    enabled: true,
    ack: false,
    proactive: { allowed: true, digest: false },
  } as never)
  const mock = createMockAdapter({ connectionId: 'c1' })
  await gw.register(mock)
  return { mock, community: community.id, internal: internal.id }
}

const view = async (i: Instance) => {
  const res = await i.app.request(`/agents/${i.agentId}/heartbeat`)
  expect(res.status).toBe(200)
  return (await res.json()) as {
    config: Record<string, unknown>
    orders: Array<StandingOrder & { reportLabel: string }>
    checklist: { exists: boolean; empty: boolean }
    watched: Array<{ nodeId: string; title: string }>
    notes: { path: string; exists: boolean }
    beats: Array<{
      status: string
      reason: string | null
      trigger?: string
      items: Array<{ decision?: string }>
    }>
  }
}
const configure = async (i: Instance, body: Record<string, unknown>) => {
  const res = await i.app.request(`/agents/${i.agentId}/heartbeat`, json('PATCH', body))
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}
const write = (i: Instance, text: string) =>
  i.server.deps.library.writeText(checklistPath(i.agentId), text)
const ALWAYS = { activeFrom: '00:00', activeTo: '00:00' }
const beatSession = async (i: Instance): Promise<string> =>
  JSON.stringify(await i.server.factory.peek(`heartbeat:${i.agentId}`).messages({ limit: 100 }))
let slot = Date.now()
const fire = (i: Instance) => i.server.heartbeats.heartbeat(i.agentId, { slot: ++slot })
async function beatsEnd(i: Instance, count: number) {
  await i.server.heartbeats.idle()
  await until('beats recorded', async () => {
    const beats = (await view(i)).beats
    return beats.length >= count && beats[0]?.status !== 'running'
  })
}
const bell = async (i: Instance) =>
  (
    (await (await i.app.request('/notifications')).json()) as {
      notifications: Array<{ kind: string; title: string; body: string }>
    }
  ).notifications
const EMPTY = 'nothing to watch: no standing order and an empty checklist'
const WATCH = 'Watch the community chat for anything unusual and report it to me here'
/** An order of an admin that reports to the internal group, tagging them. */
const order = (
  i: Instance,
  report: StandingOrder['report'],
  over: Partial<Parameters<typeof addOrder>[2]> = {},
) =>
  addOrder(i.server.deps, i.agentId, {
    text: WATCH,
    by: 'ident-1',
    name: 'Vian',
    role: 'admin',
    uid: '1001',
    report,
    mention: true,
    ...over,
  })

describe('orders make the heartbeat run', () => {
  test('nothing to watch means no model call; an order (or a plain line) makes the beat run', async () => {
    const i = instance(OK)
    const rooms = await connect(i)
    await configure(i, ALWAYS)
    // there is no enabled toggle: it is on, and a beat with nothing to watch costs nothing
    let v = await view(i)
    expect(v.config).toMatchObject({ enabled: true, everyMinutes: 30 })
    expect(v.checklist).toMatchObject({ exists: false, empty: true })
    expect(await fire(i)).toMatchObject({ started: false, reason: EMPTY })
    expect(i.model.calls).toHaveLength(0)
    await write(i, '# Heartbeat checklist\n<!-- nothing yet -->\n')
    expect(await fire(i)).toMatchObject({ started: false, reason: EMPTY })
    expect(i.model.calls).toHaveLength(0)
    // an order is a readable line in the file, with its tail, and it appears in the view
    const added = await order(i, { kind: 'chat', connectionId: 'c1', nodeId: rooms.internal })
    expect(added.created).toBe(true)
    const file = (await i.server.deps.library.read(checklistPath(i.agentId)))?.text ?? ''
    expect(file).toContain(
      `- ${WATCH} <!-- order:${added.order.id} by:ident-1 name:Vian role:admin`,
    )
    expect(file).toContain(`report:chat:c1/${rooms.internal}`)
    expect(file).toContain('mention:yes')
    v = await view(i)
    expect(v.checklist.empty).toBe(false)
    expect(v.orders).toHaveLength(1)
    expect(v.orders[0]).toMatchObject({ text: WATCH, reportLabel: 'Internal', mention: true })
    expect((await fire(i)).started).toBe(true)
    await beatsEnd(i, 1)
    const text = await beatSession(i)
    expect(text).toContain('## Standing orders')
    expect(text).toContain(`[${added.order.id}] ${WATCH}`)
    expect(text).toContain('Report to an order only when')
    expect(text).toContain(`/library/notes/heartbeat/${i.slug}/`)
    expect(text).toContain('platform user id 1001')
  })

  test('a hand-written line is a checklist item that reports nowhere but the digest', async () => {
    const i = instance([
      call('team_status', {}),
      call('channel_send', {
        action: 'send',
        connection: 'c1',
        conversation: 'internal',
        text: 'hi',
      }),
      final('ok'),
    ])
    const rooms = await connect(i)
    await configure(i, ALWAYS)
    await write(i, '- look at the community chat for a spam wave')
    expect((await view(i)).orders).toEqual([])
    expect((await view(i)).checklist.empty).toBe(false)
    await fire(i)
    await beatsEnd(i, 1)
    expect(await beatSession(i)).toContain('No standing order reports to a chat')
    expect(rooms.mock.sent).toEqual([])
  })

  test('an order can be removed from the app: only its line goes', async () => {
    const i = instance([])
    const rooms = await connect(i)
    await write(i, '# Mine\n- my own item\n')
    const a = await order(i, { kind: 'chat', connectionId: 'c1', nodeId: rooms.internal })
    const b = await order(i, { kind: 'web', sessionId: `dm:${i.agentId}` }, { text: 'Another job' })
    const res = await i.app.request(
      `/agents/${i.agentId}/heartbeat/orders/${a.order.id}`,
      json('DELETE'),
    )
    expect(res.status).toBe(200)
    const file = (await i.server.deps.library.read(checklistPath(i.agentId)))?.text ?? ''
    expect(file).toContain('- my own item')
    expect(file).toContain(`order:${b.order.id}`)
    expect(file).not.toContain(`order:${a.order.id}`)
    expect(
      (await i.app.request(`/agents/${i.agentId}/heartbeat/orders/${a.order.id}`, json('DELETE')))
        .status,
    ).toBe(404)
  })
})

describe('the gate (pure)', () => {
  const to = { connectionId: 'c1', nodeId: 'n1' }
  test('reads pass, download and every other post is refused, only the order destinations are allowed', () => {
    const send = (input: Record<string, unknown>, target: never, allowed = [to]) =>
      heartbeatChannelRefusal({ toolName: 'channel_send', input }, { allowed, target })
    expect(
      heartbeatChannelRefusal(
        { toolName: 'channel_read', input: { action: 'history' } },
        { allowed: [], target: undefined },
      ),
    ).toBeUndefined()
    expect(
      heartbeatChannelRefusal(
        { toolName: 'channel_read', input: { action: 'download' } },
        { allowed: [to], target: undefined },
      ),
    ).toContain('download')
    expect(send({ action: 'send' }, to as never, [])).toContain('No standing order reports')
    expect(send({ action: 'send' }, to as never)).toBeUndefined()
    expect(
      send({ action: 'send' }, to as never, [{ connectionId: 'c2', nodeId: 'x' }, to]),
    ).toBeUndefined()
    expect(send({ action: 'reply' }, to as never)).toContain('action "reply"')
    expect(send({ action: 'upload' }, to as never)).toContain('action "upload"')
    expect(send({ action: 'react' }, to as never)).toContain('action "react"')
    expect(send({ action: 'send', member: 'ana' }, to as never)).toContain('member')
    expect(send({ action: 'send' }, { connectionId: 'c1', nodeId: 'other' } as never)).toContain(
      'only to the destination of a standing order',
    )
    expect(send({ action: 'send' }, { error: 'unknown conversation' } as never)).toContain(
      'unknown conversation',
    )
  })

  test('the daily cap is per destination, and a repeat is refused', () => {
    const now = Date.UTC(2026, 9, 12, 9, 0)
    const here = 'chat:c1/n1'
    const other = 'chat:c1/n2'
    const posts = [
      ...Array.from({ length: PER_DESTINATION_DAILY_CAP - 1 }, (_, k) => ({
        at: now - 3_600_000 + k,
        to: here,
      })),
      { at: now - 1_000, to: other },
    ]
    const state = { fingerprints: {}, posts }
    expect(checkPost(state, here, 'New spam wave!', now, 'UTC').ok).toBe(true)
    const full = { fingerprints: {}, posts: [...posts, { at: now - 500, to: here }] }
    const r = checkPost(full, here, 'New spam wave!', now, 'UTC')
    expect(r).toMatchObject({ ok: false })
    expect((r as { reason: string }).reason).toContain(`limit of ${PER_DESTINATION_DAILY_CAP}`)
    // another destination still has room, and yesterday's posts do not count
    expect(checkPost(full, other, 'New spam wave!', now, 'UTC').ok).toBe(true)
    const old = { fingerprints: {}, posts: [{ at: now - 30 * 3_600_000, to: here }] }
    const ok = checkPost(old, here, 'New spam wave!', now, 'UTC', 1)
    expect(ok.ok).toBe(true)
    const again = checkPost(
      { fingerprints: { [(ok as { fingerprint: string }).fingerprint]: now - 60_000 }, posts: [] },
      here,
      'new spam wave',
      now,
      'UTC',
    )
    expect(again).toMatchObject({ ok: false })
    expect((again as { reason: string }).reason).toContain('same message')
    // the same words to another place are not a repeat
    expect(
      checkPost(
        {
          fingerprints: { [(ok as { fingerprint: string }).fingerprint]: now - 60_000 },
          posts: [],
        },
        other,
        'new spam wave',
        now,
        'UTC',
      ).ok,
    ).toBe(true)
  })

  test('the watch rule: named chats, else every group; never a DM', () => {
    const nodes = [
      { connectionId: 'c1', nodeId: 'node-aaaa', title: 'Community', kind: 'room', allowed: true },
      { connectionId: 'c1', nodeId: 'node-bbbb', title: 'Signals', kind: 'room', allowed: true },
      { connectionId: 'c1', nodeId: 'node-cccc', title: 'Internal', kind: 'room', allowed: true },
      { connectionId: 'c1', nodeId: 'node-dddd', title: 'Ana', kind: 'direct', allowed: true },
      { connectionId: 'c1', nodeId: 'node-eeee', title: 'Closed', kind: 'room', allowed: false },
    ]
    expect(watchedNodes(nodes, '- look at everything').map((x) => x.nodeId)).toEqual([
      'node-aaaa',
      'node-bbbb',
      'node-cccc',
    ])
    expect(watchedNodes(nodes, '- watch Signals for wrong posts').map((x) => x.nodeId)).toEqual([
      'node-bbbb',
    ])
    expect(watchedNodes(nodes, '# only a heading\n<!-- Signals -->').map((x) => x.nodeId)).toEqual([
      'node-aaaa',
      'node-bbbb',
      'node-cccc',
    ])
    expect(
      activityLines([{ nodeId: 'node-aaaa', title: 'Community', count: 3, capped: false }], {
        since: 0,
        trigger: 'activity',
      }).join('\n'),
    ).toContain('Community (conversation node-aaaa): 3 new')
  })
})

describe('a beat in the chats', () => {
  // conversations are named by their native id: the node ids are minted when the chats are created
  const community = { connection: 'c1', conversation: 'community' }
  const internal = { connection: 'c1', conversation: 'internal' }

  test('reads the chats, posts only to the order destination, tags the asker: not elsewhere, not twice, not over the cap', async () => {
    const sends = Array.from({ length: PER_DESTINATION_DAILY_CAP + 1 }, (_, k) =>
      call('channel_send', {
        action: 'send',
        ...internal,
        mention: ['1001'],
        text: `Finding number ${k + 1}: something different`,
      }),
    )
    const i = instance([
      call('team_status', {}),
      call('channel_read', { action: 'history', ...community }),
      call('chat_history', { connection: 'c1', chat: 'community' }),
      call('channel_read', { action: 'download', ...community, attachment: '1' }),
      call('channel_send', { action: 'send', ...community, text: 'wrong place' }),
      call('channel_send', { action: 'reply', ...internal, replyTo: '1', text: 'a reply' }),
      call('channel_send', { action: 'send', ...internal, text: 'Spam wave in Community' }),
      call('channel_send', { action: 'send', ...internal, text: 'spam wave in community!' }),
      ...sends,
      final('attention', [{ title: 'Spam wave in Community' }]),
    ])
    const rooms = await connect(i)
    await configure(i, ALWAYS)
    // given from the web app: the giver can read every chat the agent is allowed in (a phantom
    // chat identity would be a giver who is gone, and a beat reads nothing for them)
    await order(
      i,
      { kind: 'chat', connectionId: 'c1', nodeId: rooms.internal },
      { by: 'web:owner' },
    )
    // the asker is a known person of the connection (a mention needs one)
    await rooms.mock.say({
      chat: 'community',
      from: { id: '1001', name: 'Vian', username: 'vian' },
      text: 'hello team',
    })
    await rooms.mock.say({
      chat: 'community',
      from: { id: '9', name: 'Eve' },
      text: 'buy my coin now!!!',
    })
    const fired = await fire(i)
    // the new messages may have started an early beat first: it is the same beat for this test
    if (!fired.started) expect(fired.reason).toContain('is running')
    await beatsEnd(i, 1)
    const text = await beatSession(i)
    // reads: the chat history came back, a download was refused
    expect(text).toContain('buy my coin now!!!')
    expect(text).toContain('channel_read download')
    // posts: not to another chat, not a reply; a repeat and the posts over the cap are refused
    expect(text).toContain('only to the destination of a standing order')
    expect(text).toContain('action \\"reply\\"')
    expect(text).toContain('the same message was posted')
    expect(text).toContain(`limit of ${PER_DESTINATION_DAILY_CAP}`)
    await until('the allowed posts sent', () => rooms.mock.sent.length >= PER_DESTINATION_DAILY_CAP)
    await sleep(80)
    expect(rooms.mock.sent).toHaveLength(PER_DESTINATION_DAILY_CAP)
    expect(rooms.mock.sent.every((m) => m.conversationId === 'internal')).toBe(true)
    expect(rooms.mock.sent[0]?.rendered).toContain('Spam wave in Community')
    // the asker is tagged (the mention is a platform user id)
    expect(
      rooms.mock.sent.find((m) => m.rendered.includes('Finding number 1'))?.rendered,
    ).toContain('@Vian')
  })

  test('without an order a beat cannot post at all, and reads still work', async () => {
    const i = instance([
      call('team_status', {}),
      call('channel_describe', {}),
      call('channel_send', { action: 'send', ...internal, text: 'hello' }),
      final('ok'),
    ])
    const rooms = await connect(i)
    await write(i, '- look around')
    await configure(i, ALWAYS)
    await fire(i)
    await beatsEnd(i, 1)
    const text = await beatSession(i)
    expect(text).toContain('Conversation')
    expect(text).toContain('No standing order reports to a chat')
    expect(rooms.mock.sent).toEqual([])
  })

  test('the gate follows the orders: a removed order no longer allows its chat on the next beat', async () => {
    const i = instance([
      call('team_status', {}),
      call('channel_send', { action: 'send', ...internal, text: 'first' }),
      final('ok'),
      call('team_status', {}),
      call('channel_send', { action: 'send', ...internal, text: 'second' }),
      final('ok'),
    ])
    const rooms = await connect(i)
    await configure(i, ALWAYS)
    const a = await order(i, { kind: 'chat', connectionId: 'c1', nodeId: rooms.internal })
    await write(
      i,
      `${(await i.server.deps.library.read(checklistPath(i.agentId)))?.text ?? ''}- keep this plain item\n`,
    )
    await fire(i)
    await beatsEnd(i, 1)
    await until('first post', () => rooms.mock.sent.length === 1)
    const { removeOrder } = await import('../src/app/standing-orders.ts')
    await removeOrder(i.server.deps, i.agentId, a.order.id)
    await fire(i)
    await beatsEnd(i, 2)
    expect(await beatSession(i)).toContain('No standing order reports to a chat')
    expect(rooms.mock.sent).toHaveLength(1)
  })

  test('a post goes through the proactive policy: refused where the chat does not allow it', async () => {
    const i = instance([
      call('team_status', {}),
      call('channel_send', { action: 'send', ...community, text: 'hello community' }),
      final('ok'),
    ])
    const rooms = await connect(i)
    // the destination is a chat that does not allow unasked posts
    await configure(i, ALWAYS)
    await order(i, { kind: 'chat', connectionId: 'c1', nodeId: rooms.community })
    await fire(i)
    await beatsEnd(i, 1)
    expect(rooms.mock.sent).toEqual([])
    expect((await beatSession(i)).toLowerCase()).toContain('proactive')
  })

  test('an order asked in the web chat reports into that thread and rings the bell', async () => {
    const ref = { id: '' }
    const i = instance([
      call('team_status', {}),
      call('heartbeat_report', { order: 'nope', text: 'x' }),
      () => call('heartbeat_report', { order: ref.id, text: 'Spam wave in Community' }),
      () => call('heartbeat_report', { order: ref.id, text: 'spam wave in community!' }),
      final('attention', [
        { title: 'Spam wave', decision: 'report', reason: 'five posts in a row' } as never,
      ]),
    ] as never)
    await connect(i)
    await configure(i, ALWAYS)
    const sessionId = `dm:${i.agentId}`
    const web = await order(
      i,
      { kind: 'web', sessionId },
      { by: 'web:owner', name: 'the owner', role: 'owner', mention: false, uid: undefined },
    )
    ref.id = web.order.id
    expect((await view(i)).orders[0]).toMatchObject({ reportLabel: 'the web chat' })
    await fire(i)
    await beatsEnd(i, 1)
    const text = await beatSession(i)
    expect(text).toContain('there is no active standing order nope')
    expect(text).toContain('Reported to the web chat')
    expect(text).toContain('the same message was posted')
    // the report is in the thread (a notice, no model call) and in the bell
    const thread = JSON.stringify(await i.server.factory.peek(sessionId).messages({ limit: 50 }))
    expect(thread).toContain('Spam wave in Community')
    const alerts = (await bell(i)).filter((n) => n.body === 'Spam wave in Community')
    expect(alerts).toHaveLength(1)
    expect((await view(i)).beats[0]?.items[0]).toMatchObject({ decision: 'report' })
  })
})

describe('waking on activity', () => {
  test('new messages start one early beat, debounced to 10 minutes; the model sees where the activity is', async () => {
    const i = instance([call('team_status', {}), final('ok'), ...OK])
    const rooms = await connect(i)
    await configure(i, ALWAYS)
    await order(i, { kind: 'chat', connectionId: 'c1', nodeId: rooms.internal })
    // a burst in the community chat: one early beat after the settle time
    for (const t of ['one', 'two', 'three'])
      await rooms.mock.say({ chat: 'community', from: { id: '9', name: 'Eve' }, text: t })
    await until('the early beat', async () => (await view(i)).beats.length >= 1)
    await beatsEnd(i, 1)
    const first = (await view(i)).beats[0]
    expect(first).toMatchObject({ status: 'ok', trigger: 'activity' })
    expect(await beatSession(i)).toContain('(conversation')
    expect(await beatSession(i)).toContain('3 new')
    // more messages inside the gap: no second beat now (the next one waits for the gap)
    for (const t of ['four', 'five'])
      await rooms.mock.say({ chat: 'community', from: { id: '9', name: 'Eve' }, text: t })
    await sleep(200)
    expect((await view(i)).beats).toHaveLength(1)
    const plan = await planActivityWake(i.server.deps, {
      connectionId: 'c1',
      nodeId: rooms.community,
      at: Date.now(),
    })
    expect(plan?.agentId).toBe(i.agentId)
    expect((plan?.notBefore ?? 0) - Date.now()).toBeGreaterThan(9 * 60_000 - 5_000)
    expect((plan?.notBefore ?? 0) - Date.now()).toBeLessThan(10 * 60_000)
    // the place it reports to is watched like any other (the internal group it sits in)
    expect(
      await planActivityWake(i.server.deps, {
        connectionId: 'c1',
        nodeId: rooms.internal,
        at: Date.now(),
      }),
    ).toBeDefined()
  })

  test('always on, only inside active hours, and only with something to watch', async () => {
    const i = instance([])
    const rooms = await connect(i)
    const wake = () =>
      planActivityWake(i.server.deps, {
        connectionId: 'c1',
        nodeId: rooms.community,
        at: Date.now(),
      })
    await configure(i, ALWAYS)
    expect(await wake()).toBeUndefined() // nothing to watch: no order, no checklist
    await write(i, '# nothing\n')
    expect(await wake()).toBeUndefined()
    await order(i, { kind: 'chat', connectionId: 'c1', nodeId: rooms.internal })
    expect(await wake()).toBeDefined()
    const m = new Date().getUTCHours()
    await configure(i, {
      activeFrom: `${String((m + 3) % 24).padStart(2, '0')}:00`,
      activeTo: `${String((m + 5) % 24).padStart(2, '0')}:00`,
      timezone: 'UTC',
    })
    expect(await wake()).toBeUndefined() // outside active hours
  })

  test('an activity beat with no new messages makes no model call and leaves no record', async () => {
    const i = instance([])
    const rooms = await connect(i)
    await configure(i, ALWAYS)
    await order(i, { kind: 'chat', connectionId: 'c1', nodeId: rooms.internal })
    const out = await i.server.heartbeats.heartbeat(i.agentId, {
      slot: ++slot,
      trigger: 'activity',
    })
    expect(out).toMatchObject({ started: false, reason: 'no new activity' })
    expect(i.model.calls).toHaveLength(0)
    expect((await view(i)).beats).toEqual([])
  })
})

describe('urgent findings in a team without a lead', () => {
  test('they reach the bell, and the digest still has a host', async () => {
    const i = instance(
      [
        call('team_status', {}),
        final('attention', [{ title: 'Spam wave', urgent: true, kind: 'chat.spam' }]),
      ],
      { custom: true },
    )
    expect(i.server.deps.agents.list().some((a) => a.role === 'lead')).toBe(false)
    await configure(i, ALWAYS)
    await write(i, '- look at the chats')
    // the digest routine exists although nobody is the lead
    expect(i.server.deps.routines.getByProgram(DIGEST_KEY)).toBeDefined()
    expect((await fire(i)).started).toBe(true)
    await beatsEnd(i, 1)
    const alerts = (await bell(i)).filter((x) => x.kind === 'alert')
    expect(alerts.map((a) => a.title)).toEqual(['Spam wave'])
    expect((await view(i)).beats[0]?.status).toBe('attention')
  })
})

describe('notes and decisions', () => {
  const noteStep = (extra: Record<string, unknown> = {}) =>
    call('heartbeat_note', {
      chat: 'Internal',
      messageIds: ['12', '13'],
      noticed: 'Budi promised the report by 15:00',
      decision: 'note',
      confidence: 'seen',
      ...extra,
    })

  test('notes go to one append-only file per day under the agent path, and nowhere else', async () => {
    const i = instance([
      call('team_status', {}),
      noteStep(),
      noteStep({ noticed: 'Ana asked a question, nobody answered yet', decision: 'note' }),
      call('memory_create', { path: '/library/notes/heartbeat/other/x.md', file_text: 'x' }),
      call('memory_create', { path: '/library/elsewhere.md', file_text: 'x' }),
      final('ok'),
    ])
    await connect(i)
    await configure(i, ALWAYS)
    await write(i, '- watch the internal group')
    await fire(i)
    await beatsEnd(i, 1)
    const notes = await view(i)
    expect(notes.notes.path).toMatch(
      new RegExp(`^/library/notes/heartbeat/${i.slug}/\\d{4}-\\d{2}-\\d{2}\\.md$`),
    )
    expect(notes.notes.exists).toBe(true)
    const file = await i.server.deps.library.read(notes.notes.path)
    const lines = (file?.text ?? '').split('\n').filter((l) => l.startsWith('- '))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain(
      '[Internal] ids 12,13: Budi promised the report by 15:00 (note, seen)',
    )
    const body = file?.text ?? ''
    expect(body.indexOf('Budi promised')).toBeLessThan(body.indexOf('Ana asked'))
    const text = await beatSession(i)
    expect(text).toContain('Not available in a heartbeat: memory_create')
    expect(await i.server.deps.library.read('/library/elsewhere.md')).toBeUndefined()
    expect(await i.server.deps.library.read('/library/notes/heartbeat/other/x.md')).toBeUndefined()
  })

  test('decisions and reasons are recorded; a note stays out of the digest, an escalation rings the bell', async () => {
    const i = instance([
      call('team_status', {}),
      final('attention', [
        {
          title: 'Promise due',
          decision: 'report',
          reason: 'Budi promised it for 15:00 and it is 16:00',
        },
        { title: 'Pricing chat', decision: 'note', reason: 'banter, nobody needs anything' },
        { title: 'Wrong signal', decision: 'escalate', reason: 'a signal was posted wrong' },
      ] as never),
    ])
    await connect(i)
    await configure(i, ALWAYS)
    await write(i, '- look')
    await fire(i)
    await beatsEnd(i, 1)
    const v = (await view(i)) as unknown as {
      beats: Array<{ items: Array<{ title: string; decision?: string; reason?: string }> }>
      digest: { buffered: number }
    }
    expect(
      v.beats[0]?.items.map((x) => [
        x.title,
        x.decision,
        x.reason !== undefined && x.reason !== '',
      ]),
    ).toEqual([
      ['Promise due', 'report', true],
      ['Pricing chat', 'note', true],
      ['Wrong signal', 'escalate', true],
    ])
    expect(v.digest.buffered).toBe(2)
    expect((await bell(i)).map((a) => a.title)).toEqual(['Wrong signal'])
  })

  test('the prompt names the order of a member with a privacy limit, and web orders the report tool', async () => {
    const i = instance(OK)
    const rooms = await connect(i)
    await configure(i, ALWAYS)
    await order(
      i,
      { kind: 'chat', connectionId: 'c1', nodeId: rooms.internal },
      { role: 'member', mention: false },
    )
    await order(
      i,
      { kind: 'web', sessionId: `dm:${i.agentId}` },
      {
        text: 'Tell me about failed runs',
        by: 'web:owner',
        role: 'owner',
        uid: undefined,
        mention: false,
      },
    )
    await fire(i)
    await beatsEnd(i, 1)
    const text = await beatSession(i)
    expect(text).toContain('asked by a member: report only what that member could read themselves')
    expect(text).toContain('heartbeat_report with the order id')
    expect(text).toContain('When in doubt, write a note')
  })
})
