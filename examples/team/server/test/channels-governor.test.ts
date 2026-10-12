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
import { webCryptoVault } from 'eharness/providers'
import { scriptedModel } from 'eharness/testing'
import { z } from 'zod'
import { auditArgs, reportFailure } from '../src/infra/channels/governor.ts'
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
  parkWaitMs: 3000,
  floodStorm: { count: 3, windowMs: 60_000 },
}

function make(limits: GovernorLimits = LIMITS) {
  const c = clock()
  const audits: AuditRecord[] = []
  const parks: Array<{ scope: string; ms: number }> = []
  const storms: string[] = []
  const governor = createGovernor({
    limitsOf: () => limits,
    now: c.now,
    sleep: c.sleep,
    audit: (r) => audits.push(r),
    onPark: (e) => parks.push({ scope: e.scope, ms: e.ms }),
    onStorm: (e) => storms.push(e.reason),
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
    const governor = createGovernor({
      limitsOf: () => LIMITS,
      now: c.now,
      sleep: c.sleep,
      onStorm: (e) => outbound.open(e.connectionId, e.reason),
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
