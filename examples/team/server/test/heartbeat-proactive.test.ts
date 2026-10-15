/**
 * The proactive heartbeat (docs/plans/P40-team-autonomous-operations.md, D9): the checklist is
 * visible (empty = does nothing, a suggestion to insert), a beat reads the chats of the agent's
 * connections, posts only to its `reportTo` (daily cap, no repeats, through the proactive policy),
 * wakes early on new messages (debounced, no activity = no model call), and urgent findings reach
 * the bell in a team with no lead. Scripted models and a mock chat adapter only.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webCryptoVault } from 'eharness/providers'
import { type ScriptedModel, type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { createAgent, updateAgent } from '../src/app/agents.ts'
import { planActivityWake } from '../src/app/heartbeat.ts'
import {
  activityLines,
  checklistPath,
  checkPost,
  DIGEST_KEY,
  heartbeatChannelRefusal,
  watchedNodes,
} from '../src/domain/heartbeat.ts'
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
    checklist: { exists: boolean; empty: boolean; suggestion: string }
    destinations: Array<{ nodeId: string; label: string; proactive: boolean }>
    watched: Array<{ nodeId: string; title: string }>
    postsToday: number
    notes: { path: string; exists: boolean }
    beats: Array<{ status: string; reason: string | null; trigger?: string }>
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
      notifications: Array<{ kind: string; title: string }>
    }
  ).notifications

describe('the checklist is visible', () => {
  test('empty = does nothing, with a suggestion to insert; a real line makes it run', async () => {
    const i = instance([])
    await connect(i)
    await configure(i, { enabled: true, ...ALWAYS })
    let v = await view(i)
    expect(v.checklist).toMatchObject({ exists: false, empty: true })
    expect(v.checklist.suggestion).toContain('community chats')
    // the suggestion itself is a real checklist; inserting it is the owner's click, never automatic
    expect(v.checklist.exists).toBe(false)
    await write(i, '# Heartbeat checklist\n<!-- nothing yet -->\n')
    v = await view(i)
    expect(v.checklist).toMatchObject({ exists: true, empty: true })
    expect(await fire(i)).toMatchObject({ started: false, reason: 'empty checklist' })
    await write(i, v.checklist.suggestion)
    expect((await view(i)).checklist.empty).toBe(false)
  })

  test('reportTo must be a conversation of the agent connections; the list names them', async () => {
    const i = instance([])
    const rooms = await connect(i)
    const v = await view(i)
    expect(v.destinations.map((d) => d.label).sort()).toEqual(['Community', 'Internal'])
    expect(v.destinations.find((d) => d.nodeId === rooms.internal)?.proactive).toBe(true)
    expect(v.destinations.find((d) => d.nodeId === rooms.community)?.proactive).toBe(false)
    const bad = await configure(i, { reportTo: { connectionId: 'c1', nodeId: 'nope' } })
    expect(bad.status).toBeGreaterThanOrEqual(400)
    const ok = await configure(i, {
      reportTo: { connectionId: 'c1', nodeId: rooms.internal },
      maxPostsPerDay: 3,
    })
    expect(ok.status).toBe(200)
    expect((await view(i)).config).toMatchObject({
      reportTo: { connectionId: 'c1', nodeId: rooms.internal },
      maxPostsPerDay: 3,
      wakeOnActivity: false,
      minGapMinutes: 10,
    })
    expect((await configure(i, { maxPostsPerDay: -1 })).status).toBeGreaterThanOrEqual(400)
  })
})

describe('the gate (pure)', () => {
  const to = { connectionId: 'c1', nodeId: 'n1' }
  test('reads pass, download and every other post is refused, only the destination is allowed', () => {
    const send = (input: Record<string, unknown>, target: never, reportTo: typeof to | null = to) =>
      heartbeatChannelRefusal({ toolName: 'channel_send', input }, { reportTo, target })
    expect(
      heartbeatChannelRefusal(
        { toolName: 'channel_read', input: { action: 'history' } },
        { reportTo: null, target: undefined },
      ),
    ).toBeUndefined()
    expect(
      heartbeatChannelRefusal(
        { toolName: 'channel_read', input: { action: 'download' } },
        { reportTo: to, target: undefined },
      ),
    ).toContain('download')
    expect(send({ action: 'send' }, to as never, null)).toContain('No place to report to')
    expect(send({ action: 'send' }, to as never)).toBeUndefined()
    expect(send({ action: 'reply' }, to as never)).toContain('action "reply"')
    expect(send({ action: 'upload' }, to as never)).toContain('action "upload"')
    expect(send({ action: 'react' }, to as never)).toContain('action "react"')
    expect(send({ action: 'send', member: 'ana' }, to as never)).toContain('member')
    expect(send({ action: 'send' }, { connectionId: 'c1', nodeId: 'other' } as never)).toContain(
      'only to its report destination',
    )
    expect(send({ action: 'send' }, { error: 'unknown conversation' } as never)).toContain(
      'unknown conversation',
    )
  })

  test('the daily cap and the repeat check', () => {
    const now = Date.UTC(2026, 9, 12, 9, 0)
    const state = { fingerprints: {}, posts: [now - 3_600_000, now - 1_000] }
    const r = checkPost(state, { maxPostsPerDay: 2 }, 'New spam wave!', now, 'UTC')
    expect(r).toMatchObject({ ok: false })
    expect((r as { reason: string }).reason).toContain('limit of 2')
    // yesterday's posts do not count
    const old = { fingerprints: {}, posts: [now - 30 * 3_600_000] }
    const ok = checkPost(old, { maxPostsPerDay: 1 }, 'New spam wave!', now, 'UTC')
    expect(ok.ok).toBe(true)
    const again = checkPost(
      { fingerprints: { [(ok as { fingerprint: string }).fingerprint]: now - 60_000 }, posts: [] },
      { maxPostsPerDay: 6 },
      'new spam wave',
      now,
      'UTC',
    )
    expect(again).toMatchObject({ ok: false })
    expect((again as { reason: string }).reason).toContain('same message')
  })

  test('the watch rule: named chats, else every group; never a DM; the report chat is watched too', () => {
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

  test('reads the chats, posts only to reportTo: not elsewhere, not twice, not over the cap', async () => {
    const i = instance([
      call('team_status', {}),
      call('channel_read', { action: 'history', ...community }),
      call('chat_history', { ...community }),
      call('channel_read', { action: 'download', ...community, attachment: '1' }),
      call('channel_send', { action: 'send', ...community, text: 'wrong place' }),
      call('channel_send', { action: 'reply', ...internal, replyTo: '1', text: 'a reply' }),
      call('channel_send', { action: 'send', ...internal, text: 'Spam wave in Community' }),
      call('channel_send', { action: 'send', ...internal, text: 'spam wave in community!' }),
      call('channel_send', { action: 'send', ...internal, text: 'An angry member in Community' }),
      call('channel_send', { action: 'send', ...internal, text: 'A question waits for hours' }),
      final('attention', [{ title: 'Spam wave in Community' }]),
    ])
    const rooms = await connect(i)
    await configure(i, {
      enabled: true,
      ...ALWAYS,
      reportTo: { connectionId: 'c1', nodeId: rooms.internal },
      maxPostsPerDay: 2,
    })
    await write(i, '- watch the community chat for anything unusual')
    await rooms.mock.say({
      chat: 'community',
      from: { id: '9', name: 'Eve' },
      text: 'buy my coin now!!!',
    })
    expect((await fire(i)).started).toBe(true)
    await beatsEnd(i, 1)
    const text = await beatSession(i)
    // reads: the chat history came back, a download was refused
    expect(text).toContain('buy my coin now!!!')
    expect(text).toContain('channel_read download')
    // posts: not to another chat, not a reply, only the destination; a repeat and the 3rd are refused
    expect(text).toContain('only to its report destination')
    expect(text).toContain('action \\"reply\\"')
    expect(text).toContain('the same message was posted')
    expect(text).toContain('limit of 2')
    await until('two posts sent', () => rooms.mock.sent.length >= 2)
    await sleep(60)
    expect(rooms.mock.sent.map((m) => m.message.text)).toEqual([
      'Spam wave in Community',
      'An angry member in Community',
    ])
    expect(rooms.mock.sent.every((m) => m.conversationId === 'internal')).toBe(true)
    expect((await view(i)).postsToday).toBe(2)
  })

  test('without reportTo a beat cannot post at all, and reads still work', async () => {
    const i = instance([
      call('team_status', {}),
      call('channel_describe', {}),
      call('channel_send', { action: 'send', ...internal, text: 'hello' }),
      final('ok'),
    ])
    const rooms = await connect(i)
    await configure(i, { enabled: true, ...ALWAYS })
    await write(i, '- look around')
    await fire(i)
    await beatsEnd(i, 1)
    const text = await beatSession(i)
    expect(text).toContain('Conversation')
    expect(text).toContain('No place to report to')
    expect(rooms.mock.sent).toEqual([])
  })

  test('a post goes through the proactive policy: refused where the chat does not allow it', async () => {
    const i = instance([
      call('team_status', {}),
      call('channel_send', { action: 'send', ...community, text: 'hello community' }),
      final('ok'),
    ])
    const rooms = await connect(i)
    // the destination is a chat that does not allow unasked posts
    await configure(i, {
      enabled: true,
      ...ALWAYS,
      reportTo: { connectionId: 'c1', nodeId: rooms.community },
    })
    await write(i, '- look around')
    await fire(i)
    await beatsEnd(i, 1)
    expect(rooms.mock.sent).toEqual([])
    expect((await beatSession(i)).toLowerCase()).toContain('proactive')
  })
})

describe('waking on activity', () => {
  test('new messages start one early beat, debounced; the model sees where the activity is', async () => {
    const i = instance([call('team_status', {}), final('ok'), ...OK])
    const rooms = await connect(i)
    await configure(i, {
      enabled: true,
      ...ALWAYS,
      wakeOnActivity: true,
      minGapMinutes: 10,
      reportTo: { connectionId: 'c1', nodeId: rooms.internal },
    })
    await write(i, '- keep an eye on the chats')
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
    // the place it reports to is watched like any other (the internal group it sits in)
    expect(
      await planActivityWake(i.server.deps, {
        connectionId: 'c1',
        nodeId: rooms.internal,
        at: Date.now(),
      }),
    ).toBeDefined()
  })

  test('off by default, only inside active hours, and with a real checklist', async () => {
    const i = instance([])
    const rooms = await connect(i)
    const wake = () =>
      planActivityWake(i.server.deps, {
        connectionId: 'c1',
        nodeId: rooms.community,
        at: Date.now(),
      })
    await configure(i, { enabled: true, ...ALWAYS })
    await write(i, '- look')
    expect(await wake()).toBeUndefined() // wakeOnActivity is off
    await configure(i, { wakeOnActivity: true })
    expect(await wake()).toBeDefined()
    await write(i, '# nothing\n')
    expect(await wake()).toBeUndefined() // empty checklist
    await write(i, '- look')
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
    await connect(i)
    await configure(i, { enabled: true, ...ALWAYS, wakeOnActivity: true })
    await write(i, '- keep an eye on the chats')
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
    await configure(i, { enabled: true, ...ALWAYS })
    await write(i, '- look at the chats')
    // the digest routine exists although nobody is the lead
    expect(i.server.deps.routines.getByProgram(DIGEST_KEY)).toBeDefined()
    expect((await fire(i)).started).toBe(true)
    await beatsEnd(i, 1)
    const alerts = (await bell(i)).filter((x) => x.kind === 'alert')
    expect(alerts.map((a) => a.title)).toEqual(['Spam wave'])
    // the same finding is not rung twice
    expect((await view(i)).beats[0]?.status).toBe('attention')
  })
})

describe('modes, notes and decisions', () => {
  const internal = { connection: 'c1', conversation: 'internal' }
  const noteStep = (extra: Record<string, unknown> = {}) =>
    call('heartbeat_note', {
      chat: 'Internal',
      messageIds: ['12', '13'],
      noticed: 'Budi promised the report by 15:00',
      decision: 'note',
      ...extra,
    })

  test('notes mode never posts, even to its own report chat; speak mode posts to the chat it observes', async () => {
    const steps = [
      call('team_status', {}),
      call('channel_send', { action: 'send', ...internal, text: 'Budi, the report is due' }),
      final('ok'),
    ]
    const a = instance(steps)
    const ra = await connect(a)
    await configure(a, {
      enabled: true,
      ...ALWAYS,
      mode: 'notes',
      reportTo: { connectionId: 'c1', nodeId: ra.internal },
    })
    await write(a, '- watch the internal group')
    await fire(a)
    await beatsEnd(a, 1)
    expect(await beatSession(a)).toContain('No place to report to')
    expect(ra.mock.sent).toEqual([])
    // the same chat is both observed and the place to speak
    const b = instance(steps)
    const rb = await connect(b)
    await configure(b, {
      enabled: true,
      ...ALWAYS,
      mode: 'speak',
      wakeOnActivity: true,
      reportTo: { connectionId: 'c1', nodeId: rb.internal },
    })
    await write(b, '- watch the internal group')
    expect((await view(b)).watched.map((w) => w.nodeId)).toContain(rb.internal)
    await fire(b)
    await beatsEnd(b, 1)
    await until('the post', () => rb.mock.sent.length === 1)
    expect(rb.mock.sent[0]?.conversationId).toBe('internal')
  })

  test('default mode: notes without a report chat, speak for a stored config that has one', async () => {
    const i = instance([])
    const rooms = await connect(i)
    expect((await view(i)).config).toMatchObject({ mode: 'notes', reportTo: null })
    // a config stored before modes existed (no `mode`) with a report chat keeps speaking
    const stored = {
      ...((await view(i)).config as object),
      reportTo: { connectionId: 'c1', nodeId: rooms.internal },
    } as Record<string, unknown>
    delete stored.mode
    i.server.deps.heartbeat.store.setConfig(i.agentId, stored as never, Date.now())
    expect((await view(i)).config).toMatchObject({ mode: 'speak' })
    expect((await configure(i, { mode: 'loud' })).status).toBeGreaterThanOrEqual(400)
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
    await configure(i, { enabled: true, ...ALWAYS })
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
    expect(lines[0]).toContain('[Internal] ids 12,13: Budi promised the report by 15:00 (note)')
    // append-only: the first line is still there after the second
    const body = file?.text ?? ''
    expect(body.indexOf('Budi promised')).toBeLessThan(body.indexOf('Ana asked'))
    // any other path is refused by the gate
    const text = await beatSession(i)
    expect(text).toContain('Not available in a heartbeat: memory_create')
    expect(await i.server.deps.library.read('/library/elsewhere.md')).toBeUndefined()
    expect(await i.server.deps.library.read('/library/notes/heartbeat/other/x.md')).toBeUndefined()
  })

  test('off mode keeps no notes', async () => {
    const i = instance([call('team_status', {}), noteStep(), final('ok')])
    await connect(i)
    await configure(i, { enabled: true, ...ALWAYS, mode: 'off' })
    await write(i, '- look')
    await fire(i)
    await beatsEnd(i, 1)
    expect(await beatSession(i)).toContain('Notes are off')
    expect((await view(i)).notes.exists).toBe(false)
  })

  test('decisions and reasons are recorded; a note stays out of the digest, an escalation rings the bell', async () => {
    const i = instance([
      call('team_status', {}),
      final('attention', [
        {
          title: 'Promise due',
          decision: 'say',
          reason: 'Budi promised it for 15:00 and it is 16:00',
        },
        { title: 'Pricing chat', decision: 'note', reason: 'banter, nobody needs anything' },
        { title: 'Wrong signal', decision: 'escalate', reason: 'a signal was posted wrong' },
      ] as never),
    ])
    await connect(i)
    await configure(i, { enabled: true, ...ALWAYS })
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
      ['Promise due', 'say', true],
      ['Pricing chat', 'note', true],
      ['Wrong signal', 'escalate', true],
    ])
    expect(v.digest.buffered).toBe(2)
    expect((await bell(i)).map((a) => a.title)).toEqual(['Wrong signal'])
  })

  test('the prompt carries the rubric only where speaking is possible, and the notes to read', async () => {
    const speak = instance(OK)
    const rs = await connect(speak)
    await configure(speak, {
      enabled: true,
      ...ALWAYS,
      mode: 'speak',
      reportTo: { connectionId: 'c1', nodeId: rs.internal },
    })
    await write(speak, '- look')
    await fire(speak)
    await beatsEnd(speak, 1)
    const text = await beatSession(speak)
    expect(text).toContain('Speak in a chat only when')
    expect(text).toContain('When in doubt, write a note')
    expect(text).toContain(`/library/notes/heartbeat/${speak.slug}/`)
    const notes = instance(OK)
    await connect(notes)
    await configure(notes, { enabled: true, ...ALWAYS, mode: 'notes' })
    await write(notes, '- look')
    await fire(notes)
    await beatsEnd(notes, 1)
    const t2 = await beatSession(notes)
    expect(t2).not.toContain('Speak in a chat only when')
    expect(t2).toContain('You never post to a chat in this mode')
  })
})
