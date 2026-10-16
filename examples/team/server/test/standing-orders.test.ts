/**
 * Standing orders (docs/plans/P51-proactive-and-health.md): the `standing_order` tool in the web
 * chat and in chat channels (roles, destinations), and the file format of `HEARTBEAT.md`. Scripted
 * models and a mock chat adapter only.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webCryptoVault } from 'eharness/providers'
import { type ScriptedModel, type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { updateAgent } from '../src/app/agents.ts'
import { listOrders } from '../src/app/standing-orders.ts'
import { checklistIsEmpty, checklistPath, parseBeatResult } from '../src/domain/heartbeat.ts'
import {
  checklistIsBlank,
  formatOrderLine,
  parseChecklist,
  parseOrderLine,
  type StandingOrder,
  withOrder,
  withoutOrder,
} from '../src/domain/standing-orders.ts'
import { createMockAdapter, type MockAdapter } from '../src/infra/channels/index.ts'
import type { ModelConfig } from '../src/infra/eh/provider.ts'
import { compose, type Server } from '../src/main.ts'
import { postAs, userMessage } from './support/http.ts'

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
const KEY = new Uint8Array(32).fill(5)
const TUNING = { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 }
const wire = (m: ScriptedModel): string => JSON.stringify(m.prompts)
const call = (toolName: string, input: Record<string, unknown>, id: string): ScriptedStepInput => ({
  toolCalls: [{ toolName, input, toolCallId: id }],
})
const say = (t: string): ScriptedStepInput => ({ text: t })

const sample = (over: Partial<StandingOrder> = {}): StandingOrder => ({
  id: 'o1',
  text: 'Pantau channel komunitas, laporkan yang aneh.',
  by: 'ident-1',
  name: 'Ana --> <b>',
  role: 'admin',
  uid: '1001',
  report: { kind: 'chat', connectionId: 'c 1', nodeId: 'n/1' },
  mention: true,
  at: 1_700_000_000_000,
  active: true,
  kind: 'watch',
  refs: [],
  needs: [],
  ...over,
})

describe('the file format (pure)', () => {
  test('an order is a readable list item with a machine-readable tail, and it round-trips', () => {
    const line = formatOrderLine(sample())
    expect(line.startsWith('- Pantau channel komunitas, laporkan yang aneh. <!-- order:o1 ')).toBe(
      true,
    )
    // a name can never close the comment
    expect(line.match(/-->/g)).toHaveLength(1)
    expect(parseOrderLine(line)).toEqual(sample())
    const web = sample({
      report: { kind: 'web', sessionId: 'dm:abc' },
      mention: false,
      uid: undefined,
    })
    expect(parseOrderLine(formatOrderLine(web))).toEqual(web)
    expect(parseOrderLine(formatOrderLine(sample({ active: false })))?.active).toBe(false)
  })

  test('hand-written lines are plain checklist items; a broken tail is plain too', () => {
    const text = [
      '# Heartbeat checklist',
      '<!-- note -->',
      '- my own item',
      '- half order <!-- order:x -->',
      '- bad destination <!-- order:y report:nowhere:1 -->',
      formatOrderLine(sample()),
      '',
    ].join('\n')
    const p = parseChecklist(text)
    expect(p.orders.map((o) => o.id)).toEqual(['o1'])
    expect(p.plain).toEqual(['- my own item', '- half order', '- bad destination'])
  })

  test('only active orders count: blank = no plain item and no active order', () => {
    expect(checklistIsBlank(undefined)).toBe(true)
    expect(checklistIsBlank('# only\n<!-- comment -->')).toBe(true)
    expect(checklistIsBlank(withOrder(undefined, sample()))).toBe(false)
    expect(checklistIsBlank(withOrder(undefined, sample({ active: false })))).toBe(true)
    expect(checklistIsEmpty(withOrder(undefined, sample()))).toBe(false)
    expect(parseChecklist(withOrder(undefined, sample({ active: false }))).active).toEqual([])
  })

  test('adding keeps the owner lines, removing deletes only that line', () => {
    const base = '# Mine\n- keep me\n'
    const a = withOrder(base, sample({ id: 'a' }))
    const b = withOrder(a, sample({ id: 'b', text: 'Another job' }))
    expect(b.startsWith(base)).toBe(true)
    const left = withoutOrder(b, 'a')
    expect(left).toContain('- keep me')
    expect(parseChecklist(left).orders.map((o) => o.id)).toEqual(['b'])
    expect(withOrder(undefined, sample())).toContain('# Heartbeat checklist')
  })

  test('the old word for a report is read as report', () => {
    const r = parseBeatResult({
      status: 'attention',
      items: [
        { title: 'x', decision: 'say' },
        { title: 'y', decision: 'whatever' },
      ],
    })
    expect(r?.items.map((i) => i.decision)).toEqual(['report', undefined])
  })
})

interface Instance {
  server: Server
  model: ScriptedModel
  agentId: string
  slug: string
}

function instance(steps: ScriptedStepInput[]): Instance {
  const dir = mkdtempSync(join(tmpdir(), 'team-so-'))
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
    instanceId: 'so-test',
    models: config,
    env: {},
    tuning: TUNING,
    eventsPollMs: 30,
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
    channels: {
      vault: webCryptoVault(KEY),
      collect: { quietMs: 25, maxWaitMs: 300, maxItems: 20 },
      purgeEveryMs: 0,
      maintenanceMs: 0,
      delivery: { retryBaseMs: 20, retryMaxMs: 80 },
    },
  })
  servers.push(server)
  const def = server.deps.agents.getBySlug('lead')
  if (def === undefined) throw new Error('seed missing')
  updateAgent(server.deps, def.id, { model: 'm-agent' })
  return { server, model, agentId: def.id, slug: def.slug }
}

const admin = { id: '1001', name: 'Vian Dwi', username: 'vian' }
const member = { id: '1002', name: 'Budi', username: 'budi' }
const guest = { id: '1003', name: 'Eve', username: 'eve' }

interface Rooms {
  mock: MockAdapter
  internal: string
  community: string
  closed: string
}
async function connect(i: Instance): Promise<Rooms> {
  const gw = i.server.channels
  gw.configure({
    connectionId: 'c1',
    agentId: i.agentId,
    rate: { chatMinIntervalMs: 0 },
    people: { defaultRole: 'guest', policy: {} },
  })
  const room = (nativeId: string, title: string, extra: Record<string, unknown> = {}) => {
    const n = gw.settings.ensureNode('c1', { nativeId, kind: 'room', title })
    gw.settings.set(n.id, { enabled: true, ack: false, ...extra } as never)
    return n.id
  }
  const internal = room('internal', 'Internal', { proactive: { allowed: true, digest: false } })
  const community = room('community', 'Community')
  const closed = gw.settings.ensureNode('c1', { nativeId: 'closed', kind: 'room', title: 'Closed' })
  gw.people.setRole('c1', admin.id, { role: 'admin' }, 'owner')
  gw.people.setRole('c1', member.id, { role: 'member' }, 'owner')
  const mock = createMockAdapter({ connectionId: 'c1' })
  await gw.register(mock)
  return { mock, internal, community, closed: closed.id }
}

const file = async (i: Instance): Promise<string> =>
  (await i.server.deps.library.read(checklistPath(i.agentId)))?.text ?? ''

/** A person writes to the agent in a group and the agent's reply is awaited. */
async function ask(
  rooms: Rooms,
  from: { id: string; name: string; username: string },
  text: string,
  reply: string,
  chat = 'internal',
): Promise<void> {
  const before = rooms.mock.sent.length
  await rooms.mock.say({ chat, from, text: `@team_bot ${text}`, mentionSelf: true })
  await until(`reply "${reply}"`, () =>
    rooms.mock.sent.slice(before).some((s) => s.message.text === reply),
  )
}

const WATCH =
  'analisis setiap saat ada yang aneh ngga di channel komunitas, kalau ada laporkan ke saya'

describe('standing_order in a chat channel', () => {
  test('an admin asks in the group: it reports exactly there, tags them, and is a line in HEARTBEAT.md', async () => {
    const i = instance([
      call('standing_order', { action: 'add', instruction: WATCH }, 'a1'),
      say('ok, saved'),
      call('standing_order', { action: 'add', instruction: WATCH }, 'a2'),
      say('ok, again'),
      call('standing_order', { action: 'list' }, 'a3'),
      say('ok, listed'),
    ])
    const rooms = await connect(i)
    await ask(rooms, admin, WATCH, 'ok, saved')
    const orders = await listOrders(i.server.deps, i.agentId)
    expect(orders).toHaveLength(1)
    expect(orders[0]).toMatchObject({
      text: WATCH,
      role: 'admin',
      name: 'Vian Dwi',
      uid: '1001',
      mention: true,
      active: true,
      report: { kind: 'chat', connectionId: 'c1', nodeId: rooms.internal },
    })
    const text = await file(i)
    expect(text).toContain(`report:chat:c1/${rooms.internal}`)
    expect(text).toContain('mention:yes')
    expect(wire(i.model)).toContain('Standing order saved')
    // the same words from the same person to the same place are not stacked
    await ask(rooms, admin, WATCH, 'ok, again')
    expect(wire(i.model)).toContain('Already ongoing')
    expect(await listOrders(i.server.deps, i.agentId)).toHaveLength(1)
    // a heartbeat routine is on for the agent
    expect(i.server.deps.routines.getByProgram(`sys:heartbeat:${i.agentId}`)?.status).toBe('active')
    await ask(rooms, admin, 'what do you watch', 'ok, listed')
    expect(wire(i.model)).toContain('Standing orders (1)')
  })

  test('an admin may name another connected chat; an unknown or closed chat is refused readably', async () => {
    const i = instance([
      call('standing_order', { action: 'add', instruction: WATCH, chat: 'community' }, 'b1'),
      say('b1 done'),
      call('standing_order', { action: 'add', instruction: 'watch x', chat: 'nowhere' }, 'b2'),
      say('b2 done'),
      call('standing_order', { action: 'add', instruction: 'watch y', chat: 'closed' }, 'b3'),
      say('b3 done'),
    ])
    const rooms = await connect(i)
    await ask(rooms, admin, 'report to the community chat', 'b1 done')
    const [named] = await listOrders(i.server.deps, i.agentId)
    expect(named).toMatchObject({
      report: { kind: 'chat', connectionId: 'c1', nodeId: rooms.community },
      mention: false,
    })
    // the community chat does not allow unasked posts: the model is told to say so
    expect(wire(i.model)).toContain('does not allow unasked posts')
    await ask(rooms, admin, 'also this', 'b2 done')
    expect(wire(i.model)).toContain('nowhere')
    expect(wire(i.model)).toContain('is not an allowed conversation of c1')
    await ask(rooms, admin, 'and this', 'b3 done')
    expect(wire(i.model)).toContain('closed')
    expect(await listOrders(i.server.deps, i.agentId)).toHaveLength(1)
  })

  test('a member cannot have a report posted in a group, and cannot name another chat', async () => {
    const i = instance([
      call('standing_order', { action: 'add', instruction: WATCH }, 'c1'),
      say('c1 done'),
      call('standing_order', { action: 'add', instruction: WATCH, chat: 'community' }, 'c2'),
      say('c2 done'),
    ])
    const rooms = await connect(i)
    await ask(rooms, member, 'watch the community', 'c1 done')
    expect(wire(i.model)).toContain('a member gets reports privately')
    await ask(rooms, member, 'report to community', 'c2 done')
    expect(wire(i.model)).toContain('reports of a member go back to that member privately')
    expect(await listOrders(i.server.deps, i.agentId)).toEqual([])
  })

  test('a member in a direct chat gets private reports; who may remove what', async () => {
    const i = instance([
      call('standing_order', { action: 'add', instruction: 'tell me about failed runs' }, 'd1'),
      say('d1 done'),
      call('standing_order', { action: 'list' }, 'd2'),
      say('d2 done'),
      call('standing_order', { action: 'remove', match: WATCH.slice(0, 20) }, 'd3'),
      say('d3 done'),
      call('standing_order', { action: 'remove', match: 'failed runs' }, 'd4'),
      say('d4 done'),
    ])
    const rooms = await connect(i)
    // the admin's own order exists first
    const { addOrder } = await import('../src/app/standing-orders.ts')
    await addOrder(i.server.deps, i.agentId, {
      text: WATCH,
      by: 'ident-admin',
      name: 'Vian',
      role: 'admin',
      uid: admin.id,
      report: { kind: 'chat', connectionId: 'c1', nodeId: rooms.internal },
      mention: true,
    })
    i.server.channels.pairing.link('c1', 'u-budi', 'owner')
    const before = rooms.mock.sent.length
    const dm = async (text: string, reply: string) => {
      await rooms.mock.say({ chat: 'u-budi', kind: 'dm', from: member, text })
      await until(reply, () => rooms.mock.sent.slice(before).some((s) => s.message.text === reply))
    }
    await dm('tell me about failed runs, always', 'd1 done')
    const mine = (await listOrders(i.server.deps, i.agentId)).find((o) => o.role === 'member')
    expect(mine).toMatchObject({
      role: 'member',
      mention: false,
      report: { kind: 'chat', connectionId: 'c1' },
    })
    expect(mine?.report.kind === 'chat' && mine.report.nodeId).not.toBe(rooms.internal)
    // a member sees only their own orders
    await dm('what do you watch', 'd2 done')
    const seen = wire(i.model)
    expect(seen).toContain('Standing orders (1)')
    // a member cannot end an order of somebody else; they can end their own
    await dm('stop watching the community', 'd3 done')
    expect(wire(i.model)).toContain('no standing order matches')
    await dm('stop the failed runs thing', 'd4 done')
    expect(wire(i.model)).toContain('Stopped: order')
    const left = await listOrders(i.server.deps, i.agentId)
    expect(left.map((o) => o.role)).toEqual(['admin'])
  })

  test('an admin can end the order of a member; "stop" with one order of theirs removes it', async () => {
    const i = instance([
      call('standing_order', { action: 'remove', match: 'failed' }, 'e1'),
      say('e1 done'),
      call('standing_order', { action: 'remove' }, 'e2'),
      say('e2 done'),
    ])
    const rooms = await connect(i)
    const { addOrder } = await import('../src/app/standing-orders.ts')
    await addOrder(i.server.deps, i.agentId, {
      text: 'tell me about failed runs',
      by: 'ident-member',
      name: 'Budi',
      role: 'member',
      uid: member.id,
      report: { kind: 'chat', connectionId: 'c1', nodeId: rooms.internal },
      mention: false,
    })
    await ask(rooms, admin, 'stop that', 'e1 done')
    expect(await listOrders(i.server.deps, i.agentId)).toEqual([])
    await addOrder(i.server.deps, i.agentId, {
      text: 'my own job',
      by: 'ident-x',
      name: 'Vian',
      role: 'admin',
      uid: admin.id,
      report: { kind: 'chat', connectionId: 'c1', nodeId: rooms.internal },
      mention: true,
    })
    await ask(rooms, admin, 'berhenti memantau', 'e2 done')
    expect(wire(i.model)).toContain('Stopped: order')
    expect(await listOrders(i.server.deps, i.agentId)).toEqual([])
  })

  test('a guest gets nothing', async () => {
    const i = instance([
      call('standing_order', { action: 'add', instruction: WATCH }, 'g1'),
      say('g1 done'),
    ])
    const rooms = await connect(i)
    await ask(rooms, guest, 'watch the community', 'g1 done')
    expect(wire(i.model)).toContain('Not allowed')
    expect(await listOrders(i.server.deps, i.agentId)).toEqual([])
  })
})

describe('standing_order in the web chat', () => {
  test('the owner asks in a web thread: the report goes back to that thread; list; stop removes it', async () => {
    const i = instance([
      call('standing_order', { action: 'add', instruction: WATCH }, 'w1'),
      say('Saved.'),
      call('standing_order', { action: 'list' }, 'w2'),
      say('Listed.'),
      call('standing_order', { action: 'remove' }, 'w3'),
      say('Stopped.'),
    ])
    const send = async (text: string) =>
      (
        await i.server.app.request('/sessions/dm:lead/chat', postAs('dm:lead', userMessage(text)))
      ).text()
    await send(WATCH)
    const [o] = await listOrders(i.server.deps, i.agentId)
    expect(o).toMatchObject({
      role: 'owner',
      by: 'web:owner',
      mention: false,
      report: { kind: 'web', sessionId: `dm:${i.agentId}` },
    })
    expect((await file(i)).toLowerCase()).toContain('setiap saat')
    await send('what do you watch?')
    expect(wire(i.model)).toContain('reports to the web chat')
    await send('stop')
    expect(wire(i.model)).toContain('Stopped: order')
    expect(await listOrders(i.server.deps, i.agentId)).toEqual([])
    // the chats of an agent with a heartbeat are told when to use the tool
    expect(wire(i.model)).toContain('## Standing orders')
  })

  test('the owner names a chat of the agent from the web: it reports there', async () => {
    const i = instance([
      call(
        'standing_order',
        { action: 'add', instruction: WATCH, connection: 'c1', chat: 'internal', mention: false },
        'n1',
      ),
      say('Saved there.'),
    ])
    const rooms = await connect(i)
    await (
      await i.server.app.request(
        '/sessions/dm:lead/chat',
        postAs('dm:lead', userMessage('report to the internal group')),
      )
    ).text()
    const [o] = await listOrders(i.server.deps, i.agentId)
    expect(o?.report).toEqual({ kind: 'chat', connectionId: 'c1', nodeId: rooms.internal })
  })
})
