/**
 * P41 follow-up from the owner's real-group test: the medium context (where the agent is, default
 * reply length) kept apart from the persona, system rules, memory discipline in chat sessions,
 * default role per chat (trusted internal group) with bell notifications, the reminder tool
 * contract (message vs request), reminders on the Routines page, "who is here", consistent thread
 * titles and the label of an answered question. Scripted models only.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webCryptoVault } from 'eharness/providers'
import { type ScriptedModel, type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { updateAgent } from '../src/app/agents.ts'
import {
  type ChannelGateway,
  createMockAdapter,
  type MockAdapter,
} from '../src/infra/channels/index.ts'
import {
  isSmallTalk,
  mediumContext,
  memoryWriteRefusal,
  systemFactIn,
  systemRules,
} from '../src/infra/channels/medium.ts'
import { answerFromText, summarizeAnswers } from '../src/infra/channels/questions.ts'
import { misusedMessage } from '../src/infra/channels/reminders.ts'
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
const KEY = new Uint8Array(32).fill(9)
const TUNING = { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 }
const COLLECT = { quietMs: 25, maxWaitMs: 300, maxItems: 20 }

interface Instance {
  server: Server
  gw: ChannelGateway
  lead: ScriptedModel
  leadId: string
}
function instance(steps: ScriptedStepInput[], env: Record<string, string> = {}): Instance {
  const dir = mkdtempSync(join(tmpdir(), 'team-medium-'))
  dirs.push(dir)
  const lead = scriptedModel(steps)
  const config: ModelConfig = {
    provider: 'scripted',
    defaultModel: 'none',
    resolve: () => lead,
  }
  const server = compose({
    dbFile: join(dir, 'team.db'),
    instanceId: 'medium-test',
    models: config,
    env,
    tuning: TUNING,
    eventsPollMs: 30,
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
    channels: {
      vault: webCryptoVault(KEY),
      collect: COLLECT,
      typingEveryMs: 20,
      purgeEveryMs: 0,
      maintenanceMs: 0,
      delivery: { retryBaseMs: 20, retryMaxMs: 80 },
    },
  })
  servers.push(server)
  const def = server.deps.agents.getBySlug('lead')
  if (def === undefined) throw new Error('seed missing')
  updateAgent(server.deps, def.id, { model: 'm-lead' })
  server.deps.settings.patch({ timezone: 'Asia/Jakarta' }, Date.now())
  return { server, gw: server.channels, lead, leadId: def.id }
}

async function connect(
  i: Instance,
  groups: Record<string, Record<string, unknown>>,
  config: Record<string, unknown> = {},
): Promise<MockAdapter> {
  i.gw.configure({
    connectionId: 'c1',
    agentId: i.leadId,
    rate: { chatMinIntervalMs: 0 },
    people: { defaultRole: 'guest', policy: {} },
    ...config,
  })
  for (const [native, raw] of Object.entries(groups)) {
    const { topics, ...policy } = raw as {
      topics?: Record<string, Record<string, unknown>>
    } & Record<string, unknown>
    const room = i.gw.settings.ensureNode('c1', { nativeId: native, kind: 'room' })
    i.gw.settings.set(room.id, { enabled: true, ack: false, ...policy } as never)
    for (const t of Object.keys(topics ?? {}))
      i.gw.settings.ensureNode(
        'c1',
        { nativeId: `${native}/${t}`, kind: 'thread', title: t },
        native,
      )
  }
  const mock = createMockAdapter({ connectionId: 'c1' })
  await i.gw.register(mock)
  return mock
}

const ceo = { id: '1001', name: 'Vian Dwi', username: 'vian' }
const eve = { id: '1003', name: 'Eve', username: 'eve' }
const wire = (m: ScriptedModel): string => JSON.stringify(m.prompts)
const call = (toolName: string, input: Record<string, unknown>, id = 't1'): ScriptedStepInput => ({
  toolCalls: [{ toolName, input, toolCallId: id }],
})
const text = (t: string): ScriptedStepInput => ({ text: t })
const say = (mock: MockAdapter, from: typeof ceo, body: string, id: string, topic = 'produksi') =>
  mock.say({ chat: 'forum', topic, from, text: body, id, mentionSelf: true })

describe('pure rules', () => {
  test('small talk is only greetings and thanks', () => {
    expect(isSmallTalk('halo')).toBe(true)
    expect(isSmallTalk('@team_bot halo apakah sudah terhubung?')).toBe(true)
    expect(isSmallTalk('makasih ya')).toBe(true)
    expect(isSmallTalk('@team_bot')).toBe(true)
    expect(isSmallTalk('halo, task apa aja yang belum selesai?')).toBe(false)
    expect(isSmallTalk('rangkum diskusi kemarin')).toBe(false)
  })

  test('system facts are detected, ordinary notes are not', () => {
    expect(systemFactIn('- Vian adalah owner tim')).toBeDefined()
    expect(systemFactIn('Role: admin (confirmed by Vian)')).toBeDefined()
    expect(systemFactIn('- PERAN/OTORITAS: Vian @vian boleh memberi mandat')).toBeDefined()
    expect(systemFactIn('The bot is not an admin of the group, privacy mode is on')).toBeDefined()
    expect(systemFactIn('bot belum bisa membaca riwayat topik lain')).toBeDefined()
    expect(systemFactIn('Vian prefers short answers in Indonesian')).toBeUndefined()
    expect(
      systemFactIn('# Open tasks\n- finish the competitor report\n- verify prices'),
    ).toBeUndefined()
    const refusal = memoryWriteRefusal('memory_create', {
      path: '/memories/agents/x/notes.md',
      file_text: 'Vian is the owner',
    })
    expect(refusal).toContain('Not saved')
    expect(refusal).toContain('channel_status')
    expect(
      memoryWriteRefusal('memory_create', { path: 'a.md', file_text: 'prefers tea' }),
    ).toBeUndefined()
    expect(memoryWriteRefusal('memory_view', { path: '/memories' })).toBeUndefined()
  })

  test('the medium reminder says where, and the style overrides the default', () => {
    const group = mediumContext({
      platform: 'telegram',
      kind: 'group',
      chat: 'TEAMKU',
      topic: 'produksi',
    })
    expect(group).toContain('a group chat on telegram ("TEAMKU", topic "produksi")')
    expect(group).toContain('Keep replies short by default')
    expect(group).toContain('persona')
    expect(
      mediumContext({ platform: 'telegram', kind: 'group', chat: 'T', replyStyle: 'detailed' }),
    ).toContain('Thorough')
    expect(mediumContext({ platform: 'telegram', kind: 'dm' })).toContain(
      'a direct chat on telegram',
    )
    const rules = systemRules({ agentName: 'Ops', teamName: 'Acme' })
    expect(rules).toContain('You are Ops, the assistant of Acme.')
    expect(rules).toContain('Never explain internal mechanisms')
    expect(systemRules({})).toContain("You are the team's assistant.")
  })

  test('a reminder message must read as the reminder, not restate the request', () => {
    expect(misusedMessage('ingatkan saya jam 17.04 pulang', undefined, false)).toContain(
      'message must be the reminder itself',
    )
    expect(misusedMessage('Tolong ingatkan aku pulang', undefined, false)).toBeDefined()
    expect(misusedMessage('remind me to leave', undefined, false)).toBeDefined()
    expect(
      misusedMessage('Waktunya pulang', 'ingatkan nanti jam 17.04 saya mau pulang', false),
    ).toBeUndefined()
    expect(
      misusedMessage('ingatkan nanti jam 17.04', 'ingatkan nanti jam 17.04', false),
    ).toBeDefined()
    expect(misusedMessage('Time to leave', 'Time to leave', false)).toBeDefined()
    // verbatim: the person quoted the words
    expect(misusedMessage('ingatkan: kunci pintu', undefined, true)).toBeUndefined()
    // a label of its own is judged by what follows it
    expect(misusedMessage('⏰ Reminder: send the report', undefined, false)).toBeUndefined()
  })

  test('an answer shows the option label however the person named it', () => {
    const q = {
      question: 'Which?',
      header: 'Pick',
      multiSelect: false,
      options: [{ label: 'Beta' }, { label: 'Stable' }],
    }
    for (const reply of [
      '2',
      'nomor 2',
      'pilih 2',
      'option 2',
      '2.',
      'stable',
      'pilih Stable',
      '2. Stable',
    ])
      expect(answerFromText(q, reply)).toEqual({ selected: ['Stable'] })
    expect(summarizeAnswers([q], [answerFromText(q, 'nomor 1')])).toBe('Beta')
    expect(answerFromText(q, 'neither')).toEqual({ other: 'neither' })
  })
})

describe('medium context and system rules in a chat', () => {
  test('the agent gets its configured name, the rules, and a per-turn medium reminder with the node reply style', async () => {
    const i = instance([text('halo juga')], { TEAM_NAME: 'Acme' })
    const mock = await connect(i, { forum: { replyStyle: 'detailed', topics: { produksi: {} } } })
    i.gw.pairing.link('c1', ceo.id, 'owner', ceo.name)
    await say(mock, ceo, 'halo', 'm1')
    await until('reply', () => mock.sent.some((s) => s.message.text === 'halo juga'))
    const w = wire(i.lead)
    expect(w).toContain('You are Lead, the assistant of Acme.')
    expect(w).toContain('Never explain internal mechanisms')
    expect(w).toContain('Medium: you are talking in a group chat on mock')
    expect(w).toContain('Thorough answers are welcome')
    // the medium is a reminder, not part of the instructions
    expect(i.gw.mediumNote(i.gw.sessions.list()[0]?.sessionId as string)).toContain('Medium:')
  })
})

describe('memory discipline in chat sessions', () => {
  test('a write that states a role is refused with a readable reason; a plain note goes through', async () => {
    const i = instance([
      call(
        'memory_create',
        { path: '/memories/agents/x/roles.md', file_text: 'Vian adalah owner dan admin' },
        'w1',
      ),
      call(
        'memory_create',
        { path: `/memories/agents/${'lead-id'}/pref.md`, file_text: 'Vian prefers short answers' },
        'w2',
      ),
      text('done'),
    ])
    const mock = await connect(i, { forum: { topics: { produksi: {} } } })
    i.gw.pairing.link('c1', ceo.id, 'owner', ceo.name)
    await say(mock, ceo, 'catat sesuatu untuk saya', 'm1')
    await until('done', () => mock.sent.some((s) => s.message.text === 'done'))
    const w = wire(i.lead)
    expect(w).toContain('Not saved: this note records')
  })

  test('a greeting does not read memory', async () => {
    const i = instance([call('memory_view', { path: '/memories/workspace/' }, 'v1'), text('halo!')])
    const mock = await connect(i, { forum: { topics: { produksi: {} } } })
    i.gw.pairing.link('c1', ceo.id, 'owner', ceo.name)
    await say(mock, ceo, 'halo', 'm1')
    await until('reply', () => mock.sent.some((s) => s.message.text === 'halo!'))
    expect(wire(i.lead)).toContain('only a greeting or small talk')
  })
})

describe('default role per chat and bell notifications', () => {
  test('a trusted internal group makes unknown people members; one bell per new person, deduped, linking to People', async () => {
    const i = instance([text('ok'), text('ok2')])
    const mock = await connect(i, { forum: { defaultRole: 'member', topics: { produksi: {} } } })
    await say(mock, eve, 'halo', 'm1')
    await until('reply', () => mock.sent.some((s) => s.message.text === 'ok'))
    expect(wire(i.lead)).toContain('role member (chat default)')
    expect(i.gw.people.get('c1', eve.id)?.role).toBe('guest')
    expect(i.gw.people.get('c1', eve.id, i.gw.nodeOf('c1', 'forum')?.id)?.role).toBe('member')
    await say(mock, eve, 'halo lagi', 'm2')
    await until('reply 2', () => mock.sent.some((s) => s.message.text === 'ok2'))
    const bell = i.server.deps.notifications
      .list({ open: true, limit: 20 })
      .filter((n) => n.title.startsWith('New person'))
    expect(bell).toHaveLength(1)
    expect(bell[0]?.link).toBe('/channels/c1/people')
    expect(bell[0]?.title).toContain('Eve')
  })

  test('the chat default role is never shown as a plain member role; the medium note says to answer only the latest message', async () => {
    const i = instance([call('member_lookup', { query: 'Eve' }, 'l1'), text('ok')])
    const mock = await connect(i, { forum: { defaultRole: 'member', topics: { produksi: {} } } })
    await say(mock, eve, 'siapa saya', 'm1')
    await until('reply', () => mock.sent.some((s) => s.message.text === 'ok'))
    const w = wire(i.lead)
    expect(w).not.toMatch(/role member \((?!chat default)/)
    expect(w).toContain('role member (chat default)')
    expect(w).toContain('Answer only the latest message')
    expect(w).not.toContain('team web app (Channels, People)')
  })

  test('a platform admin without a role is one suggestion notification', async () => {
    const i = instance([text('ok')])
    const mock = await connect(i, { forum: { topics: { produksi: {} } } })
    await mock.emit({
      type: 'member.updated',
      dedupeKey: 'adm1',
      at: Date.now(),
      node: mock.ref('forum'),
      actor: ceo,
      role: 'admin',
    })
    await say(mock, ceo, 'halo', 'm1')
    await until('reply', () => mock.sent.some((s) => s.message.text === 'ok'))
    const titles = i.server.deps.notifications.list({ open: true, limit: 20 }).map((n) => n.title)
    expect(titles.filter((t) => t.startsWith('Confirm a role'))).toHaveLength(1)
  })
})

describe('reminder tool contract, Routines page, who is here', () => {
  const setup = async (steps: ScriptedStepInput[]) => {
    const i = instance(steps)
    const mock = await connect(i, { forum: { topics: { produksi: {} } } })
    i.gw.people.setRole('c1', ceo.id, { role: 'admin' }, 'owner')
    return { i, mock }
  }

  test('a message that restates the request is refused with a correction; the rewritten one is posted verbatim without a model call', async () => {
    const { i, mock } = await setup([
      call(
        'reminder',
        {
          action: 'create',
          message: 'ingatkan saya pulang',
          request: 'ingatkan saya pulang jam 17',
          inMinutes: 5,
          mention: [ceo.id],
        },
        'r1',
      ),
      call(
        'reminder',
        {
          action: 'create',
          message: 'Waktunya pulang',
          request: 'ingatkan saya pulang jam 17',
          inMinutes: 5,
          mention: [ceo.id],
        },
        'r2',
      ),
      text('dipasang'),
    ])
    await say(mock, ceo, 'ingatkan saya pulang jam 17', 'a1')
    await until('done', () => mock.sent.some((s) => s.message.text === 'dipasang'))
    expect(wire(i.lead)).toContain('message must be the reminder itself')
    const rows = i.gw.reminders.list('c1')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.body).toBe('Waktunya pulang')
  })

  test('reminders are listed on the Routines page with place and status, finished ones too, and cancel works', async () => {
    const { i, mock } = await setup([
      call(
        'reminder',
        { action: 'create', message: 'Waktunya pulang', inMinutes: 5, mention: [ceo.id] },
        'r1',
      ),
      call(
        'reminder',
        { action: 'create', message: 'Kirim laporan', inMinutes: 10, mention: [ceo.id] },
        'r2',
      ),
      text('dipasang'),
    ])
    await say(mock, ceo, 'pasang dua', 'a1')
    await until('done', () => mock.sent.some((s) => s.message.text === 'dipasang'))
    const [a, b] = i.gw.reminders.list('c1')
    // one fires (done), one stays active
    await i.gw.reminders.fire((a as { id: string }).id, { slot: 1 })
    const res = await i.server.app.request('/routines')
    const body = (await res.json()) as {
      routines: unknown[]
      reminders: Array<{ id: string; place: string; status: string; connectionId: string }>
    }
    expect(body.reminders.map((r) => r.status).sort()).toEqual(['active', 'done'])
    expect(body.reminders[0]?.place).toBe('Room/produksi')
    expect(body.routines).toHaveLength(0)
    // the page cancels through the channels API (`DELETE /channels/connections/{id}/reminders/{id}`), which ends here
    i.gw.reminders.cancel((b as { id: string }).id)
    const after = (await (await i.server.app.request('/routines')).json()) as {
      reminders: Array<{ status: string }>
    }
    expect(after.reminders.map((r) => r.status).sort()).toEqual(['cancelled', 'done'])
  })

  test('"who is here" lists the directory and the people seen in the chat with last seen and one hint line', async () => {
    const { i, mock } = await setup([call('member_lookup', {}, 'l1'), text('daftar')])
    await mock.say({ chat: 'forum', topic: 'produksi', from: eve, text: 'i am here', id: 'e0' })
    await say(mock, ceo, 'siapa saja di sini', 'a1')
    await until('done', () => mock.sent.some((s) => s.message.text === 'daftar'))
    const w = wire(i.lead)
    expect(w).toContain('People in')
    expect(w).toContain('last seen')
    expect(w).toContain('Eve')
    expect(w).toContain('have no role set by the team yet')
  })
})

describe('thread titles', () => {
  test('legacy channel threads are renamed to "<chat> / <topic>" once; a title a person chose stays', async () => {
    const i = instance([text('ok')])
    const mock = await connect(i, { forum: { topics: { produksi: {} } } })
    i.gw.pairing.link('c1', ceo.id, 'owner', ceo.name)
    await say(mock, ceo, 'halo', 'm1')
    await until('reply', () => mock.sent.some((s) => s.message.text === 'ok'))
    const row = i.gw.sessions.list()[0]
    const thread = i.server.deps.threads.getBySession(row?.sessionId as string)
    expect(thread?.title).toContain(' / ')
    // an older thread was named by the bare topic
    i.server.deps.threads.patch(thread?.id as string, { title: 'produksi' }, Date.now())
    expect(i.gw.retitleThreads()).toBe(1)
    expect(i.server.deps.threads.get(thread?.id as string)?.title).toContain(' / ')
    expect(i.gw.retitleThreads()).toBe(0)
    i.server.deps.threads.patch(thread?.id as string, { title: 'My own name' }, Date.now())
    expect(i.gw.retitleThreads()).toBe(0)
    expect(i.server.deps.threads.get(thread?.id as string)?.title).toBe('My own name')
  })
})
