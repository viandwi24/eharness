/**
 * Answers that are carried out and the privacy of a beat's chat reads
 * (docs/plans/P51 and P52 open questions): retire / conflict / chat-gone questions of standing orders
 * act on HEARTBEAT.md through the standing-orders layer; a beat reads only chats the givers of its
 * live orders can read and never carries what a DM said into a group. Scripted models, a mock chat
 * adapter, generic names.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webCryptoVault } from 'eharness/providers'
import { type ScriptedModel, type ScriptedStepInput, scriptedModel } from 'eharness/testing'
import { updateAgent } from '../src/app/agents.ts'
import { approveDecision, rejectDecision } from '../src/app/decisions.ts'
import { setHeartbeat } from '../src/app/heartbeat.ts'
import {
  CONFLICT_EDIT,
  CONFLICT_KEEP_A,
  CONFLICT_KEEP_B,
  CONFLICT_KEEP_BOTH,
  GONE_KEEP,
  GONE_REMOVE,
  RETIRE_KEEP,
  RETIRE_PAUSE,
  RETIRE_REMOVE,
  raiseConflicts,
  weeklyReview,
} from '../src/app/order-care.ts'
import { addOrder, listOrders } from '../src/app/standing-orders.ts'
import { checklistPath } from '../src/domain/heartbeat.ts'
import { orderHygiene } from '../src/domain/order-hygiene.ts'
import {
  formatOrderLine,
  parseChecklist,
  privatePostRefusal,
  readRefusal,
  readScopeOf,
  type StandingOrder,
} from '../src/domain/standing-orders.ts'
import { createMockAdapter } from '../src/infra/channels/index.ts'
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
let n = 0
const call = (toolName: string, input: Record<string, unknown>): ScriptedStepInput => ({
  toolCalls: [{ toolName, input, toolCallId: `a-${toolName}-${++n}` }],
})
const final = (): ScriptedStepInput => call('final_answer', { status: 'ok', items: [] })

const HOUR = 3_600_000
const DAY = 24 * HOUR

const order = (over: Partial<StandingOrder> = {}): StandingOrder => ({
  id: 'o1',
  text: 'Watch the video channel and report anomalies',
  by: 'ident-1',
  name: 'Owen',
  role: 'owner',
  uid: '1001',
  report: { kind: 'chat', connectionId: 'c1', nodeId: 'n1' },
  mention: true,
  at: Date.now() - 30 * DAY,
  active: true,
  kind: 'watch',
  refs: [],
  needs: [],
  ...over,
})

interface Instance {
  server: Server
  model: ScriptedModel
  agentId: string
  slug: string
}
function instance(steps: ScriptedStepInput[]): Instance {
  const dir = mkdtempSync(join(tmpdir(), 'team-oa-'))
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
    instanceId: 'oa-test',
    models: config,
    env: {},
    tuning: { streams: { flushMs: 5, pollMs: 20 }, inbox: { pollMs: 30 }, abortPollMs: 40 },
    eventsPollMs: 30,
    reconcile: { onBoot: false, everyMs: 0 },
    routines: { tickMs: 0 },
    heartbeat: { activitySettleMs: 20 },
    channels: {
      vault: webCryptoVault(new Uint8Array(32).fill(9)),
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
async function connect(i: Instance): Promise<{ group: string; dm: string; other: string }> {
  const gw = i.server.channels
  gw.configure({
    connectionId: 'c1',
    agentId: i.agentId,
    rate: { chatMinIntervalMs: 0 },
    people: { defaultRole: 'guest', policy: {} },
  })
  const open = (nativeId: string, kind: 'room' | 'direct', title: string): string => {
    const node = gw.settings.ensureNode('c1', { nativeId, kind, title })
    gw.settings.set(node.id, {
      enabled: true,
      ack: false,
      proactive: { allowed: true, digest: false },
    } as never)
    return node.id
  }
  const group = open('group-1', 'room', 'Team Room')
  const dm = open('dm-1', 'direct', 'Private With Sam')
  const other = open('room-2', 'room', 'Other Room')
  await gw.register(createMockAdapter({ connectionId: 'c1' }))
  return { group, dm, other }
}
const sessionText = async (i: Instance): Promise<string> =>
  JSON.stringify(await i.server.factory.peek(`heartbeat:${i.agentId}`).messages({ limit: 100 }))

const ownerInput = (report: StandingOrder['report'], over: Record<string, unknown> = {}) => ({
  text: 'Keep an eye on the community and report anything strange to the team',
  by: 'web:owner',
  name: 'Owner',
  role: 'owner',
  report,
  mention: false,
  ...over,
})

const agentOf = (i: Instance) => {
  const a = i.server.deps.agents.getBySlug('lead')
  if (a === undefined) throw new Error('seed')
  return a
}

describe('answers are carried out', () => {
  test('retire: each option removes, pauses or keeps the order, and the outcome says what was done', async () => {
    const i = instance([])
    const rooms = await connect(i)
    const deps = i.server.deps
    const agent = agentOf(i)
    const dest = { kind: 'chat' as const, connectionId: 'c1', nodeId: rooms.group }
    const monday = Date.UTC(2026, 9, 19, 10, 0)
    const orders = ['r1', 'r2', 'r3'].map((id, k) =>
      order({ id, text: `Stale instruction number ${k}`, report: dest, at: monday - 30 * DAY }),
    )
    await deps.library.writeText(
      checklistPath(i.agentId),
      `${orders.map(formatOrderLine).join('\n')}\n`,
    )
    await weeklyReview(deps, agent, orders, monday)
    const open = deps.decisions.list({ status: 'open', agentId: agent.id, limit: 20 })
    expect(open).toHaveLength(3)
    const by = (id: string) => open.find((d) => d.title.includes(`[${id}]`))
    const first = by('r1')
    expect(first?.kind === 'escalation' && first.payload.options).toEqual([
      RETIRE_REMOVE,
      RETIRE_PAUSE,
      RETIRE_KEEP,
    ])
    // an option is required: the card has buttons
    await expect(approveDecision(deps, (first as { id: string }).id)).rejects.toThrow()

    const removed = await approveDecision(deps, (by('r1') as { id: string }).id, {
      choice: RETIRE_REMOVE,
    })
    expect(removed.outcome?.effect).toContain('Removed order r1')
    const paused = await approveDecision(deps, (by('r2') as { id: string }).id, {
      choice: RETIRE_PAUSE,
    })
    expect(paused.outcome?.effect).toContain('Paused order r2')
    const kept = await approveDecision(deps, (by('r3') as { id: string }).id, {
      choice: RETIRE_KEEP,
    })
    expect(kept.outcome?.effect).toContain('Kept order r3')

    const left = await listOrders(deps, i.agentId)
    expect(left.map((o) => o.id)).toEqual(['r2', 'r3'])
    expect(left[0]).toMatchObject({ active: false })
    expect(left[0]?.pausedReason).toContain('Decision Center')
    expect(left[1]?.active).toBe(true)
    // a kept order is not asked about again at the next review
    deps.heartbeat.store.updateState(i.agentId, (s) => ({ ...s, review: undefined }), monday)
    await weeklyReview(deps, agent, left, monday + 7 * DAY)
    expect(
      deps.decisions.list({ status: 'open', agentId: agent.id, limit: 20 }).map((d) => d.title),
    ).toHaveLength(0)
    // a rejected question changes nothing
  })

  test('conflict: keep A removes B, keep both is remembered, edit leaves both and says so', async () => {
    const i = instance([])
    const rooms = await connect(i)
    const deps = i.server.deps
    const agent = agentOf(i)
    const dest = { kind: 'chat' as const, connectionId: 'c1', nodeId: rooms.group }
    const text = 'Report upload anomalies, early views and live sessions of channel AcmeAcademy'
    const mk = (id: string, by: string, extra = '') =>
      order({ id, text: `${text}${extra}`, by, report: dest, at: Date.now() - DAY })
    const check = async (a: StandingOrder, b: StandingOrder) => {
      const now = Date.now()
      const hyg = orderHygiene({
        now,
        orders: [a, b],
        destinationExists: () => true,
        giverRole: (o) => o.role,
      })
      expect(hyg.some((f) => f.kind === 'conflict')).toBe(true)
      raiseConflicts(deps, agent, hyg, [a, b], now)
      return {
        hyg,
        open: () =>
          deps.decisions
            .list({ status: 'open', agentId: agent.id, limit: 20 })
            .filter((d) => d.title.includes('overlap')),
      }
    }
    // keep A -> B goes
    let a = mk('ca', 'ident-1')
    let b = mk('cb', 'ident-2')
    await deps.library.writeText(
      checklistPath(i.agentId),
      `${[a, b].map(formatOrderLine).join('\n')}\n`,
    )
    let q = await check(a, b)
    let d = q.open()[0]
    expect(d?.kind === 'escalation' && d.payload.options).toEqual([
      CONFLICT_KEEP_A,
      CONFLICT_KEEP_B,
      CONFLICT_KEEP_BOTH,
      CONFLICT_EDIT,
    ])
    const keepA = await approveDecision(deps, (d as { id: string }).id, { choice: CONFLICT_KEEP_A })
    expect(keepA.outcome?.effect).toContain('Removed order cb')
    expect((await listOrders(deps, i.agentId)).map((o) => o.id)).toEqual(['ca'])

    // keep B -> A goes (fresh pair)
    a = mk('da', 'ident-1', ' daily')
    b = mk('db', 'ident-2', ' daily')
    await deps.library.writeText(
      checklistPath(i.agentId),
      `${[a, b].map(formatOrderLine).join('\n')}\n`,
    )
    q = await check(a, b)
    d = q.open()[0]
    await approveDecision(deps, (d as { id: string }).id, { choice: CONFLICT_KEEP_B })
    expect((await listOrders(deps, i.agentId)).map((o) => o.id)).toEqual(['db'])

    // keep both -> nothing removed, never asked again for the same words
    a = mk('ea', 'ident-1', ' weekly')
    b = mk('eb', 'ident-2', ' weekly')
    await deps.library.writeText(
      checklistPath(i.agentId),
      `${[a, b].map(formatOrderLine).join('\n')}\n`,
    )
    q = await check(a, b)
    d = q.open()[0]
    const both = await approveDecision(deps, (d as { id: string }).id, {
      choice: CONFLICT_KEEP_BOTH,
    })
    expect(both.outcome?.effect).toContain('Kept both')
    expect((await listOrders(deps, i.agentId)).map((o) => o.id)).toEqual(['ea', 'eb'])
    expect(raiseConflicts(deps, agent, q.hyg, [a, b], Date.now())).toBe(0)
    // ... unless one of them is edited
    const edited = { ...b, text: `${b.text} and the new playlists` }
    const hyg2 = orderHygiene({
      now: Date.now(),
      orders: [a, edited],
      destinationExists: () => true,
      giverRole: (o) => o.role,
    })
    expect(raiseConflicts(deps, agent, hyg2, [a, edited], Date.now())).toBe(1)
    // edit -> both stay and it says so
    d = deps.decisions
      .list({ status: 'open', agentId: agent.id, limit: 20 })
      .find((x) => x.title.includes('overlap'))
    const edit = await approveDecision(deps, (d as { id: string }).id, { choice: CONFLICT_EDIT })
    expect(edit.outcome?.effect).toContain('left as they are')
    expect((await listOrders(deps, i.agentId)).map((o) => o.id)).toEqual(['ea', 'eb'])
    expect(raiseConflicts(deps, agent, hyg2, [a, edited], Date.now())).toBe(0)

    // rejecting a question changes nothing
    const x = mk('fa', 'ident-1', ' monthly')
    const y = mk('fb', 'ident-2', ' monthly')
    await deps.library.writeText(
      checklistPath(i.agentId),
      `${[x, y].map(formatOrderLine).join('\n')}\n`,
    )
    q = await check(x, y)
    d = q.open()[0]
    await rejectDecision(deps, (d as { id: string }).id)
    expect((await listOrders(deps, i.agentId)).map((o) => o.id)).toEqual(['fa', 'fb'])
  })

  test('a gone report chat pauses the order on the next beat, once, and asks the owners', async () => {
    const i = instance([final(), final()])
    const rooms = await connect(i)
    const deps = i.server.deps
    await setHeartbeat(deps, i.agentId, { activeFrom: '00:00', activeTo: '00:00' })
    const added = await addOrder(
      deps,
      i.agentId,
      ownerInput({ kind: 'chat', connectionId: 'c1', nodeId: 'gone-node' }),
    )
    // a second, healthy order keeps the beat meaningful
    await addOrder(
      deps,
      i.agentId,
      ownerInput(
        { kind: 'chat', connectionId: 'c1', nodeId: rooms.group },
        { text: 'Watch the other thing' },
      ),
    )
    await i.server.heartbeats.heartbeat(i.agentId, { slot: Date.now() })
    await i.server.heartbeats.idle()
    const orders = await listOrders(deps, i.agentId)
    const gone = orders.find((o) => o.id === added.order.id)
    expect(gone).toMatchObject({ active: false })
    expect(gone?.pausedReason).toContain('gone')
    const open = deps.decisions
      .list({ status: 'open', agentId: i.agentId, limit: 20 })
      .filter((d) => d.title.includes('is gone'))
    expect(open).toHaveLength(1)
    expect(open[0]?.kind === 'escalation' && open[0].payload.options).toEqual([
      GONE_REMOVE,
      GONE_KEEP,
    ])
    // the next beat does not raise it again (the order is paused, not live)
    await i.server.heartbeats.heartbeat(i.agentId, { slot: Date.now() + 1 })
    await i.server.heartbeats.idle()
    expect(
      deps.decisions
        .list({ status: 'open', agentId: i.agentId, limit: 20 })
        .filter((d) => d.title.includes('is gone')),
    ).toHaveLength(1)
    // answering "remove" removes it
    const done = await approveDecision(deps, (open[0] as { id: string }).id, {
      choice: GONE_REMOVE,
    })
    expect(done.outcome?.effect).toContain('Removed order')
    expect((await listOrders(deps, i.agentId)).map((o) => o.id)).not.toContain(added.order.id)
  })
})

describe('what a beat may read and carry (pure)', () => {
  const nodes = [
    { connectionId: 'c1', nodeId: 'g1', kind: 'room', allowed: true },
    { connectionId: 'c1', nodeId: 'g2', kind: 'room', allowed: true },
    { connectionId: 'c1', nodeId: 'dm-a', kind: 'direct', allowed: true },
    { connectionId: 'c1', nodeId: 'dm-b', kind: 'direct', allowed: true },
  ]
  const member = order({
    id: 'm1',
    by: 'ident-m',
    role: 'member',
    report: { kind: 'chat', connectionId: 'c1', nodeId: 'dm-a' },
  })
  const owner = order({
    id: 'w1',
    by: 'web:owner',
    role: 'owner',
    report: { kind: 'chat', connectionId: 'c1', nodeId: 'g1' },
  })
  const reach: Record<string, string[]> = { 'ident-m': ['dm-a', 'g2'] }
  const base = {
    nodes,
    giverRole: (o: StandingOrder) => o.role,
    giverCanRead: (o: StandingOrder, id: string) =>
      o.role === 'owner' || (reach[o.by] ?? []).includes(id),
  }

  test("a member's order reaches only what the member can read", () => {
    const s = readScopeOf({ ...base, orders: [member], plainItems: false })
    expect(s.nodes.sort()).toEqual(['dm-a', 'g2'])
    expect(readRefusal(s, { title: 'Other', ids: ['dm-b'] })).toContain('Not read')
    expect(readRefusal(s, { title: 'Room 2', ids: ['topic', 'g2'] })).toBeUndefined()
    // naming a chat in the order is not the right to read it
    const naming = order({ ...member, refs: ['Private With Someone Else'] })
    expect(
      readScopeOf({ ...base, orders: [naming], plainItems: false }).nodes.includes('dm-b'),
    ).toBe(false)
  })

  test('an owner-wide order reads every allowed chat; no order and no plain item reads none', () => {
    const s = readScopeOf({ ...base, orders: [owner], plainItems: false })
    expect(s.nodes.sort()).toEqual(['dm-a', 'dm-b', 'g1', 'g2'])
    expect(readScopeOf({ ...base, orders: [], plainItems: false }).nodes).toEqual([])
    expect(readScopeOf({ ...base, orders: [], plainItems: true }).nodes).toHaveLength(4)
    expect(readRefusal(undefined, { title: 'x', ids: ['g1'] })).toContain('Not read')
    // a giver who is gone reads nothing
    const gone = readScopeOf({
      ...base,
      giverRole: () => undefined,
      orders: [owner],
      plainItems: false,
    })
    expect(gone.nodes).toEqual([])
  })

  test('what a DM said goes back to that DM or to the DM or web chat of someone who can read it, never to a group', () => {
    const web = order({
      id: 'w2',
      by: 'web:owner',
      role: 'owner',
      report: { kind: 'web', sessionId: 's1' },
    })
    const s = readScopeOf({ ...base, orders: [member, owner, web], plainItems: false })
    const title = (id: string): string => id
    const dmA = 'chat:c1/dm-a'
    const group = 'chat:c1/g1'
    // nothing private read: any destination
    expect(privatePostRefusal({ ...s, seen: [] }, group, title)).toBeUndefined()
    // the member's DM was read
    const seenA = { ...s, seen: ['dm-a'] }
    expect(privatePostRefusal(seenA, dmA, title)).toBeUndefined()
    expect(privatePostRefusal(seenA, 'web:s1', title)).toBeUndefined()
    expect(privatePostRefusal(seenA, group, title)).toContain('never to a group')
    // another person's DM: not the member's DM (the member cannot read dm-b)
    const seenB = { ...s, seen: ['dm-b'] }
    expect(privatePostRefusal(seenB, dmA, title)).toContain('Not posted')
    expect(privatePostRefusal(seenB, 'chat:c1/dm-b', title)).toBeUndefined()
    // an undefined scope carries nothing to check
    expect(privatePostRefusal(undefined, group, title)).toBeUndefined()
  })
})

describe('the gate of a beat', () => {
  test("an owner-wide order may read a DM, but a post into a group is then refused; a member's order reads none of it", async () => {
    const i = instance([
      call('chat_history', { connection: 'c1', chat: 'Private With Sam', window: 'today' }),
      call('channel_send', {
        action: 'send',
        connection: 'c1',
        conversation: 'Team Room',
        text: 'hello team',
      }),
      final(),
    ])
    const rooms = await connect(i)
    const deps = i.server.deps
    await setHeartbeat(deps, i.agentId, { activeFrom: '00:00', activeTo: '00:00' })
    await addOrder(
      deps,
      i.agentId,
      ownerInput({ kind: 'chat', connectionId: 'c1', nodeId: rooms.group }),
    )
    expect((await i.server.heartbeats.heartbeat(i.agentId, { slot: Date.now() })).started).toBe(
      true,
    )
    await i.server.heartbeats.idle()
    await until('the beat', () => i.model.calls.length >= 3)
    const text = await sessionText(i)
    expect(text).not.toContain('Not read:')
    expect(text).toContain('this beat read a private chat')
    expect(text).toContain('never to a group')
    const state = deps.heartbeat.store.state(i.agentId)
    expect(state.reads?.seen).toEqual([rooms.dm])
  })

  test("a member's order cannot read a chat its giver cannot; an unnamed chat is refused", async () => {
    const i = instance([
      call('chat_history', { connection: 'c1', chat: 'Other Room', window: 'today' }),
      call('chat_history', { connection: 'c1', window: 'today' }),
      final(),
    ])
    const rooms = await connect(i)
    const deps = i.server.deps
    await setHeartbeat(deps, i.agentId, { activeFrom: '00:00', activeTo: '00:00' })
    // the giver is a member the directory does not know: nothing is readable on their behalf
    await addOrder(deps, i.agentId, {
      ...ownerInput({ kind: 'chat', connectionId: 'c1', nodeId: rooms.dm }),
      by: 'ident-member',
      name: 'Sam',
      role: 'member',
    })
    expect(
      parseChecklist((await deps.library.read(checklistPath(i.agentId)))?.text).active,
    ).toHaveLength(1)
    await i.server.heartbeats.heartbeat(i.agentId, { slot: Date.now() })
    await i.server.heartbeats.idle()
    await until('the beat', () => i.model.calls.length >= 3)
    const text = await sessionText(i)
    expect(text).toContain('Not read: \\"Other Room\\"')
    expect(text).toContain('must name the chat')
  })
})
