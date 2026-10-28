/**
 * The per-connection API governor (docs/plans/P41-team-channels.md, "API governor"): token buckets
 * per call class, one park state shared by sends and every other call, the flood storm, and the
 * audit of what the agent did on the platform (ids and targets only, never a body). Scripted time
 * for the unit part; the mock adapter and the real gateway for the rest. No network, no model.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOutbox, memoryOutboxStore } from 'eharness/channels'
import { webCryptoVault } from 'eharness/providers'
import { scriptedModel } from 'eharness/testing'
import { z } from 'zod'
import { auditArgs, reportFailure, reportRateLimit } from '../src/infra/channels/governor.ts'
import {
  type AuditRecord,
  BOT_GOVERNOR,
  ChannelError,
  createGovernor,
  createMockAdapter,
  GovernorLimited,
  type GovernorLimits,
  governorLimitsOf,
  USER_GOVERNOR,
} from '../src/infra/channels/index.ts'
import { traitsOf } from '../src/infra/channels/model.ts'
import { createOutbound } from '../src/infra/channels/outbound.ts'
import { RateLimitsSchema } from '../src/infra/channels/policy.ts'
import type { ChannelNode } from '../src/infra/channels/types.ts'
import { compose, type Server } from '../src/main.ts'

/** A clock the test moves; `sleep` moves it. */
function clock(start = 1_000_000) {
  let t = start
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms
    },
    advance: (ms: number) => {
      t += ms
    },
  }
}

const LIMITS: GovernorLimits = {
  read: { burst: 2, perMinute: 60 },
  edit: { burst: 2, perMinute: 60 },
  admin: { burst: 1, perMinute: 6 },
  global: { burst: 100, perMinute: 6000 },
  gap: { edit: { minMs: 0, maxMs: 0 }, admin: { minMs: 0, maxMs: 0 } },
  parkWaitMs: 3000,
  floodStorm: { count: 3, windowMs: 60_000 },
}

/** The library outbox is the flood storm detector the gateway wires to the governor's parks. */
function stormBox(
  c: ReturnType<typeof clock>,
  limits: GovernorLimits,
  onStorm: (count: number, connectionId: string) => void,
) {
  return createOutbox({
    store: memoryOutboxStore(),
    send: async () => null,
    now: c.now,
    floodStorm: {
      count: () => limits.floodStorm.count,
      windowMs: () => limits.floodStorm.windowMs,
      stormKey: (parkKey) => parkKey.split('\n')[0] ?? parkKey,
    },
    onEvent: (e) => {
      if (e.type === 'storm') onStorm(e.count, e.target)
    },
  })
}

function make(limits: GovernorLimits = LIMITS) {
  const c = clock()
  const audits: AuditRecord[] = []
  const parks: Array<{ scope: string; ms: number }> = []
  const storms: string[] = []
  const box = stormBox(c, limits, (count) => storms.push(`${count} rate limits`))
  const governor = createGovernor({
    limitsOf: () => limits,
    now: c.now,
    sleep: c.sleep,
    audit: (r) => audits.push(r),
    onPark: (e) => {
      parks.push({ scope: e.scope, ms: e.ms })
      box.noteRateLimit(e.parkKey, e.ms)
    },
    floodsOf: (id) => box.floods(id),
  })
  return { c, audits, parks, storms, governor }
}

const ok = async () => 'ok'

describe('governor: token buckets', () => {
  test('a burst goes at once, then calls wait for a refill; a wait beyond the bound is refused readably', async () => {
    const { c, governor } = make()
    const t0 = c.now()
    await governor.call({ connectionId: 'c1', cls: 'read', action: 'history' }, ok)
    await governor.call({ connectionId: 'c1', cls: 'read', action: 'history' }, ok)
    expect(c.now()).toBe(t0)
    // the third read waits one second (60 per minute)
    await governor.call({ connectionId: 'c1', cls: 'read', action: 'history' }, ok)
    expect(c.now() - t0).toBeGreaterThanOrEqual(1000)
    expect(c.now() - t0).toBeLessThan(1100)
    // admin refills 6 per minute: the second call would wait 10 s, over the 3 s bound
    await governor.call({ connectionId: 'c1', cls: 'admin', action: 'ban_member' }, ok)
    const refused = await governor
      .call({ connectionId: 'c1', cls: 'admin', action: 'ban_member' }, ok)
      .catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(GovernorLimited)
    expect((refused as GovernorLimited).message).toMatch(/rate limited, retry in \d+ s/)
    expect((refused as GovernorLimited).kind).toBe('rate_limit')
  })

  test('classes are separate buckets; the global bucket counts every class and the sends', async () => {
    const { c, governor } = make({ ...LIMITS, global: { burst: 3, perMinute: 60 } })
    const t0 = c.now()
    await governor.call({ connectionId: 'c1', cls: 'read', action: 'a' }, ok)
    await governor.call({ connectionId: 'c1', cls: 'edit', action: 'b' }, ok)
    governor.charge('c1', 'send')
    // the global bucket is empty: even a fresh class waits for it
    await governor.call({ connectionId: 'c1', cls: 'admin', action: 'c' }, ok)
    expect(c.now() - t0).toBeGreaterThanOrEqual(1000)
    // another connection has its own buckets
    const t1 = c.now()
    await governor.call({ connectionId: 'other', cls: 'read', action: 'a' }, ok)
    expect(c.now()).toBe(t1)
  })

  test('a user account is stricter than a bot; the connection overrides win', () => {
    const user = governorLimitsOf('user')
    const bot = governorLimitsOf(undefined)
    expect(user.read.perMinute).toBeLessThan(bot.read.perMinute)
    expect(user.admin.perMinute).toBeLessThan(bot.admin.perMinute)
    expect(user.global.perMinute).toBeLessThan(bot.global.perMinute)
    expect(bot).toEqual(BOT_GOVERNOR)
    expect(user).toEqual(USER_GOVERNOR)
    const tuned = governorLimitsOf('user', { read: { perMinute: 5 }, floodStorm: { count: 9 } })
    expect(tuned.read).toEqual({ burst: USER_GOVERNOR.read.burst, perMinute: 5 })
    expect(tuned.floodStorm).toEqual({ count: 9, windowMs: USER_GOVERNOR.floodStorm.windowMs })
    // the connection's send limits carry the overrides
    const rate = RateLimitsSchema.parse({ governor: { admin: { burst: 1 } } })
    expect(rate.governor?.admin?.burst).toBe(1)
    expect(RateLimitsSchema.parse({}).governor).toBeUndefined()
  })
})

describe('governor: one park state', () => {
  test('a flood wait on any call parks every other call, sends included', async () => {
    const { c, governor, parks } = make()
    await expect(
      governor.call({ connectionId: 'c1', cls: 'read', action: 'history' }, async () => {
        throw new ChannelError('rate_limit', 'FLOOD_WAIT_20', 20_000)
      }),
    ).rejects.toThrow('FLOOD_WAIT_20')
    expect(parks).toEqual([{ scope: 'connection', ms: 20_000 }])
    // what the outbox asks before it sends
    expect(governor.parkedFor('c1')).toBe(20_000)
    expect(governor.parkedFor('other')).toBe(0)
    // a tool call during the park is refused with the time to wait (over the 3 s bound)
    const refused = await governor
      .call({ connectionId: 'c1', cls: 'edit', action: 'pin' }, ok)
      .catch((e: unknown) => e)
    expect(String(refused)).toContain('retry in 20 s')
    // a background job waits it out
    c.advance(0)
    const t0 = c.now()
    await governor.call({ connectionId: 'c1', cls: 'read', action: 'history', patient: true }, ok)
    expect(c.now() - t0).toBeGreaterThanOrEqual(20_000)
    expect(governor.parkedFor('c1')).toBe(0)
  })

  test('a chat scoped limit parks only that chat', async () => {
    const { governor, parks } = make()
    await expect(
      governor.call(
        { connectionId: 'c1', cls: 'edit', action: 'edit', chatKey: 'c1\nroom' },
        async () => {
          throw new ChannelError('rate_limit', 'slow mode', 8000, 'chat')
        },
      ),
    ).rejects.toThrow()
    expect(parks[0]?.scope).toBe('chat')
    expect(governor.parkedFor('c1', 'c1\nroom')).toBe(8000)
    expect(governor.parkedFor('c1', 'c1\nelsewhere')).toBe(0)
    expect(governor.parkedFor('c1')).toBe(0)
  })

  test('a raw client error is recognized by the caller-supplied classifier', async () => {
    const { governor } = make()
    await expect(
      governor.call(
        {
          connectionId: 'c1',
          cls: 'read',
          action: 'history',
          classify: (e) =>
            String(e).includes('FLOOD_WAIT_7') ? { retryAfterMs: 7000 } : undefined,
        },
        async () => {
          throw new Error('FLOOD_WAIT_7')
        },
      ),
    ).rejects.toThrow('FLOOD_WAIT_7')
    expect(governor.parkedFor('c1')).toBe(7000)
  })

  test('the same error is counted once; repeated floods ask for the breaker', async () => {
    const { governor, storms } = make()
    const error = new ChannelError('rate_limit', 'slow down', 1000)
    governor.noteError('c1', error)
    governor.noteError('c1', error)
    expect(governor.state('c1').floods).toBe(1)
    governor.park('c1', 1000)
    expect(storms).toEqual([])
    governor.park('c1', 1000)
    expect(storms).toHaveLength(1)
    expect(storms[0]).toContain('3 rate limits')
  })

  test('the outbox waits on the governor park and its flood storm opens the breaker', async () => {
    const c = clock()
    const box = stormBox(c, LIMITS, (_count, id) => outbound.open(id, 'a flood storm'))
    const governor = createGovernor({
      limitsOf: () => LIMITS,
      now: c.now,
      sleep: c.sleep,
      onPark: (e) => box.noteRateLimit(e.parkKey, e.ms),
    })
    const outbound = createOutbound({
      limitsOf: () => RateLimitsSchema.parse({ chatMinIntervalMs: 0 }),
      governor,
      now: c.now,
      sleep: c.sleep,
    })
    // a read of somebody else parked the connection: the send waits for it
    governor.park('c1', 5000)
    const t0 = c.now()
    await outbound.run({ connectionId: 'c1', conversationId: 'n1', kind: 'group' }, ok)
    expect(c.now() - t0).toBeGreaterThanOrEqual(5000)
    // floods from any call open the one breaker
    governor.park('c1', 100)
    governor.park('c1', 100)
    governor.park('c1', 100)
    expect(outbound.breaker('c1')?.open).toBe(true)
    await expect(
      outbound.run({ connectionId: 'c1', conversationId: 'n1', kind: 'group' }, ok),
    ).rejects.toThrow(/paused/)
    // resetting the outbox clears the park too (one state)
    outbound.reset('c1')
    expect(governor.parkedFor('c1')).toBe(0)
  })

  test('describe says what is parked and what the limits are', async () => {
    const { governor } = make()
    expect(governor.describe('c1')).toContain('reads 60/min')
    governor.park('c1', 12_000)
    expect(governor.describe('c1')).toContain('parked for 12 more seconds')
  })
})

describe('governor: audit', () => {
  test('every call is one record with the result, the duration and who asked; bodies never get in', async () => {
    const { c, governor, audits } = make()
    await governor.within(
      { requester: 'Vian', sessionId: 's1', agentId: 'a1', origin: 'chat' },
      async () => {
        await governor.call(
          {
            connectionId: 'c1',
            cls: 'edit',
            action: 'pin_message',
            nodeId: 'n1',
            args: {
              chat: '-1001',
              message: 5,
              text: 'a secret message body',
              title: 'Quarterly plan',
            },
          },
          async () => {
            await c.sleep(40)
            return 'done'
          },
        )
      },
    )
    expect(audits).toHaveLength(1)
    const a = audits[0] as AuditRecord
    expect(a).toMatchObject({
      kind: 'action',
      action: 'pin_message',
      nodeId: 'n1',
      result: 'ok',
      durationMs: 40,
      context: { requester: 'Vian', sessionId: 's1', agentId: 'a1' },
    })
    expect(a.args).toEqual({ chat: '-1001', message: 5 })
    expect(JSON.stringify(a)).not.toContain('secret')
    expect(JSON.stringify(a)).not.toContain('Quarterly')
  })

  test('errors, held-back calls and failures a native action answers as text are told apart', async () => {
    const { governor, audits } = make()
    await governor
      .call({ connectionId: 'c1', cls: 'read', action: 'members' }, async () => {
        throw new ChannelError('invalid', 'not an admin')
      })
      .catch(() => undefined)
    await governor.call({ connectionId: 'c1', cls: 'edit', action: 'pin_message' }, async () => {
      reportFailure('Telegram refused: not enough rights')
      return 'Telegram refused: not enough rights'
    })
    await governor
      .call({ connectionId: 'c1', cls: 'read', action: 'history' }, async () => {
        throw new ChannelError('rate_limit', 'FLOOD_WAIT_9', 9000)
      })
      .catch(() => undefined)
    await governor
      .call({ connectionId: 'c1', cls: 'read', action: 'history' }, ok)
      .catch(() => undefined)
    expect(audits.map((a) => [a.kind, a.action, a.result])).toEqual([
      ['read', 'members', 'error'],
      ['action', 'pin_message', 'error'],
      ['read', 'history', 'rate_limited'],
      ['read', 'history', 'rate_limited'],
    ])
    expect(audits[1]?.note).toContain('not enough rights')
  })

  test('auditArgs keeps ids and counters, drops anything that reads like text', () => {
    expect(
      auditArgs({
        chat: '@teamku',
        user: 99,
        message: 'abc-12',
        limit: 30,
        text: 'hello world',
        question: 'Lunch?',
        options: ['a', 'b'],
        title: 'x',
        reason: 'because I said so',
        token: '123456:ABC',
        query: 'two words',
      }),
    ).toEqual({ chat: '@teamku', user: 99, message: 'abc-12', limit: 30 })
  })
})

// --- the gateway: native actions, reads, the activity view -------------------------------------

const servers: Server[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function instance() {
  const dir = mkdtempSync(join(tmpdir(), 'team-gov-'))
  dirs.push(dir)
  const server = compose({
    dbFile: join(dir, 'team.db'),
    instanceId: 'governor-test',
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
      vault: webCryptoVault(new Uint8Array(32).fill(7)),
      purgeEveryMs: 0,
      maintenanceMs: 0,
      outbound: { sleep: async (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) },
    },
  })
  servers.push(server)
  const lead = server.deps.agents.getBySlug('lead') as { id: string }
  return { server, gw: server.channels, leadId: lead.id }
}

async function connect(i: ReturnType<typeof instance>, actions: Array<Record<string, unknown>>) {
  i.gw.configure({
    connectionId: 'c1',
    agentId: i.leadId,
    people: { defaultRole: 'admin', policy: {} },
    rate: { chatMinIntervalMs: 0 },
  } as never)
  const room = i.gw.settings.ensureNode('c1', { nativeId: 'room', kind: 'room', title: 'TEAMKU' })
  i.gw.settings.set(room.id, { enabled: true })
  const mock = createMockAdapter({ connectionId: 'c1', actions: actions as never })
  await i.gw.register(mock)
  return { mock, roomId: room.id }
}

const runs: string[] = []
const pinAction = {
  name: 'pin_message',
  risk: 'write',
  summary: 'Pin a message.',
  schema: z.object({ chat: z.string(), message: z.string(), text: z.string().optional() }),
  run: async (input: Record<string, unknown>) => {
    runs.push(String(input.message))
    return 'The message was pinned.'
  },
}

describe('gateway: native actions and reads are audited, and a flood parks everything', () => {
  test('a native action records one outbound row: action, place, requester, result, no body', async () => {
    const i = instance()
    const { roomId } = await connect(i, [pinAction])
    const adapter = i.gw.adapter('c1')
    const action = adapter?.actions?.find((a) => a.name === 'pin_message')
    const out = await i.gw.governor.within(
      { requester: 'Vian', sessionId: 's1', agentId: i.leadId, origin: 'chat' },
      () =>
        (action as NonNullable<typeof action>).run({
          chat: 'room',
          message: '5',
          text: 'private words',
        }),
    )
    expect(out).toBe('The message was pinned.')
    const rows = i.gw.activity.list('c1', { type: 'action', limit: 5 }).items
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      type: 'action',
      direction: 'out',
      action: 'pin_message',
      conversationId: roomId,
      peerName: 'Vian',
      detail: { result: 'ok', args: 'chat=room message=5', session: 's1', agent: i.leadId },
    })
    expect(JSON.stringify(rows)).not.toContain('private words')
  })

  test('platform reads of a tool are audited; the gateway own ack reaction is not', async () => {
    const i = instance()
    const { mock, roomId } = await connect(i, [])
    const adapter = i.gw.adapter('c1') as NonNullable<ReturnType<typeof i.gw.adapter>>
    const node: ChannelNode = {
      id: roomId,
      connectionId: 'c1',
      nativeId: 'room',
      kind: 'room',
      traits: traitsOf({ multiUser: true }),
      platformType: 'mock:group',
      title: 'TEAMKU',
      parentNativeId: undefined,
      meta: {},
    }
    // the gateway's own call (outside a tool): governed, not recorded
    await adapter.react?.(node, 'm1', '👍')
    expect(mock.reactions).toHaveLength(1)
    expect(
      i.gw.activity.list('c1', { limit: 20 }).items.filter((e) => e.type === 'action'),
    ).toEqual([])
    // what a tool asked for is
    await i.gw.governor.within({ requester: 'Ana', origin: 'chat' }, async () => {
      await adapter.fetchHistory?.(node, { limit: 20 })
      await adapter.listMembers?.(node, { limit: 10 })
      await adapter.pin?.(node, 'm1', true)
    })
    const rows = i.gw.activity.list('c1', { direction: 'out', limit: 20 }).items
    expect(rows.map((r) => [r.type, r.action]).sort()).toEqual([
      ['action', 'pin'],
      ['read', 'history'],
      ['read', 'members'],
    ])
    expect(rows.every((r) => r.peerName === 'Ana' && r.conversationId === roomId)).toBe(true)
  })

  test('a flood on a native call parks the sends of the outbox too, and is told to the model', async () => {
    const i = instance()
    let floods = 1
    const poll = {
      name: 'send_poll',
      risk: 'external',
      summary: 'Post a poll.',
      schema: z.object({ chat: z.string() }),
      run: async () => {
        if (floods-- > 0) throw new ChannelError('rate_limit', 'Telegram asked to slow down', 150)
        return 'The poll was posted.'
      },
    }
    const { mock } = await connect(i, [poll])
    const action = i.gw.adapter('c1')?.actions?.find((a) => a.name === 'send_poll')
    const told = await (action as NonNullable<typeof action>).run({ chat: 'room' })
    expect(told).toMatch(/^ERROR: rate limited, retry in \d+ s/)
    expect(i.gw.governor.parkedFor('c1')).toBeGreaterThan(0)
    expect(i.gw.activity.list('c1', { type: 'parked', limit: 5 }).items[0]).toMatchObject({
      direction: 'system',
      detail: { scope: 'connection', seconds: 1 },
    })
    // the audit says so
    const row = i.gw.activity.list('c1', { type: 'action', limit: 5 }).items[0]
    expect(row?.detail).toMatchObject({ result: 'rate_limited' })
    // an outbox send goes out only after the park ends (the outbox sleep is shortened: wait for real time)
    const target = i.gw.resolveTarget(i.leadId, undefined, { conversation: 'room' })
    const started = Date.now()
    await i.gw.post(target, { text: 'after the flood' })
    expect(mock.sent).toHaveLength(1)
    expect(Date.now() - started).toBeGreaterThanOrEqual(100)
    // and the next tool call is not held back anymore
    const again = await (action as NonNullable<typeof action>).run({ chat: 'room' })
    expect(again).toBe('The poll was posted.')
  })

  test('channel_describe style state: the park and the limits are readable per connection', async () => {
    const i = instance()
    await connect(i, [])
    expect(i.gw.governor.describe('c1')).toContain('API limits')
    i.gw.governor.park('c1', 30_000)
    expect(i.gw.governor.describe('c1')).toMatch(/parked for (29|30) more seconds/)
    expect(i.gw.governor.state('c1').parkedUntil).toBeGreaterThan(Date.now())
  })

  test('the activity view filters by direction and by action; inbound is in, replies and actions are out', async () => {
    const i = instance()
    const { mock, roomId } = await connect(i, [pinAction])
    // an inbound event, a delivered reply, two actions
    await mock.say({ from: { id: 'u1', name: 'Ana' }, text: 'hello', id: 'in1' })
    const target = i.gw.resolveTarget(i.leadId, undefined, { conversation: 'room' })
    await i.gw.post(target, { text: 'out' })
    const action = i.gw.adapter('c1')?.actions?.find((a) => a.name === 'pin_message')
    await (action as NonNullable<typeof action>).run({ chat: 'room', message: '1' })
    await i.gw.governor.within({ requester: 'Vian' }, async () => {
      await i.gw.adapter('c1')?.fetchHistory?.(
        {
          id: roomId,
          connectionId: 'c1',
          nativeId: 'room',
          kind: 'room',
          traits: traitsOf({ multiUser: true }),
          platformType: 'mock:group',
          title: 'TEAMKU',
          parentNativeId: undefined,
          meta: {},
        },
        { limit: 5 },
      )
    })
    const table = (q: Record<string, unknown>) =>
      i.gw.activity.table('c1', { page: 1, limit: 50, ...q } as never)
    const outs = table({ direction: 'out' })
    expect(outs.items.length).toBeGreaterThanOrEqual(2)
    expect(outs.items.every((e) => e.direction === 'out')).toBe(true)
    expect(outs.items.map((e) => e.type)).toEqual(expect.arrayContaining(['action', 'read']))
    const ins = table({ direction: 'in' })
    expect(ins.items.length).toBeGreaterThanOrEqual(1)
    expect(ins.items.every((e) => e.direction === 'in')).toBe(true)
    expect(ins.items.map((e) => e.type)).not.toContain('action')
    // by action
    const pins = table({ action: 'pin_message' })
    expect(pins.total).toBe(1)
    expect(table({ action: 'history' }).total).toBe(1)
    expect(table({ direction: 'in', action: 'history' }).total).toBe(0)
    // the search finds an action by name
    expect(table({ q: 'pin_mess' }).total).toBe(1)
    // the filter list
    expect(i.gw.activity.actions('c1')).toEqual(['history', 'pin_message'])
    // the same through the paged list
    expect(
      i.gw.activity.list('c1', { direction: 'out', action: 'history', limit: 10 }).items,
    ).toHaveLength(1)
  })
})

describe('governor: natural pause and class parks', () => {
  const PACED: GovernorLimits = {
    ...LIMITS,
    admin: { burst: 50, perMinute: 6000 },
    edit: { burst: 50, perMinute: 6000 },
    gap: { edit: { minMs: 1000, maxMs: 3000 }, admin: { minMs: 3000, maxMs: 8000 } },
  }
  function paced(random: () => number, limits: GovernorLimits = PACED) {
    const c = clock()
    const parks: Array<{ scope: string; ms: number; parkKey: string }> = []
    const governor = createGovernor({
      limitsOf: () => limits,
      now: c.now,
      sleep: c.sleep,
      random,
      onPark: (e) => void parks.push({ scope: e.scope, ms: e.ms, parkKey: e.parkKey }),
    })
    return { c, governor, parks }
  }

  test('admin calls are spaced by a random pause in the range; reads and sends are not', async () => {
    const { c, governor } = paced(() => 0.5)
    const t0 = c.now()
    const starts: number[] = []
    const admin = () =>
      governor.call({ connectionId: 'c1', cls: 'admin', action: 'set_chat_info' }, async () => {
        starts.push(c.now())
        return 'ok'
      })
    await admin()
    await admin()
    await admin()
    // 3 s + 0.5 * 5 s = 5.5 s between two starts
    expect(starts).toEqual([t0, t0 + 5500, t0 + 11_000])
    const before = c.now()
    await governor.call({ connectionId: 'c1', cls: 'read', action: 'history' }, ok)
    await governor.call({ connectionId: 'c1', cls: 'send', action: 'post' }, ok)
    expect(c.now()).toBe(before)
    // another connection has its own pace
    await governor.call({ connectionId: 'c2', cls: 'admin', action: 'x' }, ok)
    expect(c.now()).toBe(before)
  })

  test('calls that arrive together queue one pause apart', async () => {
    // a frozen clock: what each call is told to wait is the queue
    const waits: number[] = []
    const governor = createGovernor({
      limitsOf: () => PACED,
      now: () => 1_000_000,
      sleep: async (ms) => void waits.push(ms),
      random: () => 0,
    })
    await Promise.all(
      [1, 2, 3].map(() => governor.call({ connectionId: 'c1', cls: 'edit', action: 'pin' }, ok)),
    )
    expect(waits.sort((a, b) => a - b)).toEqual([1000, 2000])
  })

  test('a bot has no pause; the override sets one', () => {
    expect(governorLimitsOf('bot').gap.admin).toEqual({ minMs: 0, maxMs: 0 })
    expect(governorLimitsOf('user').gap.admin.minMs).toBeGreaterThan(0)
    const o = governorLimitsOf('user', { gap: { admin: { minMs: 10_000 } } })
    // a max below the min is lifted to it
    expect(o.gap.admin).toEqual({ minMs: 10_000, maxMs: 10_000 })
    expect(
      RateLimitsSchema.parse({ governor: { gap: { edit: { minMs: 0, maxMs: 0 } } } }),
    ).toBeTruthy()
  })

  test('a rate limit answered as text parks only the admin class: sends and reads go on', async () => {
    const { c, governor, parks } = paced(() => 0, {
      ...PACED,
      gap: { edit: { minMs: 0, maxMs: 0 }, admin: { minMs: 0, maxMs: 0 } },
    })
    const text = await governor.call(
      { connectionId: 'c1', cls: 'admin', action: 'set_chat_visibility' },
      async () => {
        reportRateLimit(120_000, 'Telegram asked the account to slow down (FLOOD_WAIT_120)')
        return 'ERROR: wait'
      },
    )
    expect(text).toBe('ERROR: wait')
    expect(parks).toEqual([{ scope: 'class', ms: 120_000, parkKey: 'c1\n@admin' }])
    const refused = await governor
      .call({ connectionId: 'c1', cls: 'admin', action: 'set_chat_info' }, ok)
      .catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(GovernorLimited)
    expect((refused as Error).message).toContain('FLOOD_WAIT_120')
    const t = c.now()
    expect(await governor.call({ connectionId: 'c1', cls: 'send', action: 'post' }, ok)).toBe('ok')
    expect(await governor.call({ connectionId: 'c1', cls: 'read', action: 'history' }, ok)).toBe(
      'ok',
    )
    expect(c.now()).toBe(t)
    const s = governor.state('c1')
    expect(s.parkedUntil).toBeUndefined()
    expect(s.chats).toEqual([])
    expect(s.classes.map((x) => x.cls)).toEqual(['admin'])
    expect(governor.describe('c1')).toContain('Chat and member changes are paused')
    // a thrown platform limit on an admin call parks the class too
    c.advance(121_000)
    await governor
      .call({ connectionId: 'c1', cls: 'admin', action: 'kick' }, async () => {
        throw new ChannelError('rate_limit', 'FLOOD_WAIT_9', 9000)
      })
      .catch(() => undefined)
    expect(parks.at(-1)).toMatchObject({ scope: 'class', parkKey: 'c1\n@admin' })
    governor.reset('c1')
    expect(governor.state('c1').classes).toEqual([])
  })
})
