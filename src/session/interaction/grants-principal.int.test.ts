/**
 * Grants by principal and the grant timing option (ADR-0070 points 1 and 2, spec 11 §3.1):
 * `grants: { by, applyAt }`, the stored key, whose principal it uses, `clearGrants(principal)`.
 */
import { describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../../agent/define-agent.ts'
import type { Principal } from '../../agent/session-types.ts'
import type { HarnessAgentConfig } from '../../agent/types.ts'
import { isHarnessError } from '../../errors.ts'
import type { HarnessUIMessage } from '../../messages/types.ts'
import { definePlugin } from '../../plugin/define-plugin.ts'
import { type ScriptedStep, scriptedModel } from '../../testing/scripted-model.ts'
import { spyMessages, spyState } from '../test-kit.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const A: Principal = { id: 'a' }
const B: Principal = { id: 'b' }
const NUL = '\u0000'

type Grants = { by?: 'session' | 'principal'; applyAt?: 'continuation' | 'now' }

function setup(
  steps: ScriptedStep[],
  grants: Grants | undefined,
  extra: Partial<HarnessAgentConfig> = {},
) {
  const log: string[] = []
  const state = spyState()
  const agent = defineHarnessAgent({
    model: scriptedModel(steps),
    contextWindow: 100_000,
    storage: { messages: spyMessages(), state },
    logger: silent,
    tools: {
      pay: tool({
        description: 'Pay',
        inputSchema: z.object({ amount: z.number(), kind: z.string().optional() }),
        execute: async ({ amount }) => {
          log.push(`pay:${amount}`)
          return `paid ${amount}`
        },
      }),
    },
    approval: { policy: { pay: 'user-approval' } },
    ...(grants === undefined ? {} : { grants }),
    ...extra,
  } as HarnessAgentConfig)
  return { agent, log, state }
}

const call = (amount: number, id: string, kind?: string): ScriptedStep => ({
  toolCalls: [{ toolName: 'pay', input: { amount, ...(kind ? { kind } : {}) }, toolCallId: id }],
})

function approvalIds(result: { pending?: { approvals: Array<{ approvalId: string }> } }): string[] {
  return (result.pending?.approvals ?? []).map((a) => a.approvalId)
}

function partState(messages: HarnessUIMessage[], id: string): string | undefined {
  for (const m of messages) {
    for (const p of m.parts) {
      if ('toolCallId' in p && p.toolCallId === id) return (p as { state: string }).state
    }
  }
  return undefined
}

describe('grants.by x grants.applyAt: a shared session', () => {
  for (const by of ['session', 'principal'] as const) {
    for (const applyAt of ['continuation', 'now'] as const) {
      test(`by ${by}, applyAt ${applyAt}`, async () => {
        const { agent, log, state } = setup(
          [
            call(1, 'a1'), // A asks
            { text: 'ok' }, // continuation of A's respond
            call(2, 'b1'), // B asks: today's behavior approves it, by principal asks again
            { text: 'ok' },
            call(4, 'a2'), // A again: granted in both modes
            { text: 'ok' },
          ],
          { by, applyAt },
        )
        const s = agent.session('shared')
        const r1 = await s.send('pay', { principal: A }).result
        await s.respond({
          approvals: [{ id: approvalIds(r1)[0] as string, approved: true, remember: 'session' }],
        }).result
        expect(log).toEqual(['pay:1'])
        expect((await state.get('shared'))?.core.grants).toEqual(
          by === 'session' ? { pay: 'always' } : { [`a${NUL}pay`]: 'always' },
        )

        const r2 = await s.send('pay', { principal: B }).result
        if (by === 'session') {
          expect(r2.stop).toBe('complete')
          expect(log).toEqual(['pay:1', 'pay:2'])
        } else {
          expect(r2.stop).toBe('tool-pending')
          expect(log).toEqual(['pay:1'])
          await s.respond({ approvals: [{ id: approvalIds(r2)[0] as string, approved: true }] })
            .result
          expect(log).toEqual(['pay:1', 'pay:2'])
        }
        const before = log.length
        const r4 = await s.send('pay', { principal: A }).result
        expect(r4.stop).toBe('complete')
        expect(log.length).toBe(before + 1)
        expect(log.at(-1)).toBe('pay:4')
        await agent.close()
      })
    }
  }
})

describe('the principal in the key is the one that asked', () => {
  test('an owner answering a member request: the grant is the member key, not the owner or a third', async () => {
    const O: Principal = { id: 'owner' }
    const M: Principal = { id: 'member' }
    const N: Principal = { id: 'other' }
    const { agent, log, state } = setup(
      [
        call(1, 'm1'),
        { text: 'ok' },
        call(2, 'm2'),
        { text: 'ok' },
        call(3, 'o1'),
        { text: 'ok' },
        call(4, 'n1'),
      ],
      { by: 'principal' },
    )
    const s = agent.session('chat')
    const r1 = await s.send('pay', { principal: M }).result
    await s.respond({
      approvals: [
        {
          id: approvalIds(r1)[0] as string,
          approved: true,
          remember: 'session',
          actor: { id: O.id },
        },
      ],
    }).result
    expect((await state.get('chat'))?.core.grants).toEqual({ [`member${NUL}pay`]: 'always' })
    const r2 = await s.send('pay', { principal: M }).result
    expect(r2.stop).toBe('complete')
    expect(log).toEqual(['pay:1', 'pay:2'])
    const r3 = await s.send('pay', { principal: O }).result
    expect(r3.stop).toBe('tool-pending')
    await s.respond({ approvals: [{ id: approvalIds(r3)[0] as string, approved: false }] }).result
    const r4 = await s.send('pay', { principal: N }).result
    expect(r4.stop).toBe('tool-pending')
    expect(log).toEqual(['pay:1', 'pay:2'])
    await agent.close()
  })
})

describe('applyAt', () => {
  async function run(applyAt: 'continuation' | 'now') {
    const { agent, log } = setup(
      [
        call(1, 'c1'),
        // step 0 of the continuation: a second call to the same tool
        call(2, 'c2'),
        { text: 'done' },
      ],
      { applyAt },
    )
    const s = agent.session('s')
    const r1 = await s.send('pay').result
    const r2 = await s.respond({
      approvals: [{ id: approvalIds(r1)[0] as string, approved: true, remember: 'session' }],
    }).result
    return { agent, log, r2 }
  }

  test("'continuation' (default): the second call in the continuation step asks", async () => {
    const { agent, log, r2 } = await run('continuation')
    expect(r2.stop).toBe('tool-pending')
    expect(log).toEqual(['pay:1'])
    await agent.close()
  })

  test("'now': the second call in the continuation step is approved without asking", async () => {
    const { agent, log, r2 } = await run('now')
    expect(r2.stop).toBe('complete')
    expect(log).toEqual(['pay:1', 'pay:2'])
    await agent.close()
  })

  for (const applyAt of ['continuation', 'now'] as const) {
    test(`${applyAt}: calls answered by the same respond() are unaffected by its grant`, async () => {
      const { agent, log } = setup(
        [
          {
            toolCalls: [
              { toolName: 'pay', input: { amount: 1 }, toolCallId: 'd1' },
              { toolName: 'pay', input: { amount: 2 }, toolCallId: 'd2' },
            ],
          },
          { text: 'done' },
        ],
        { applyAt },
      )
      const s = agent.session('s')
      const r1 = await s.send('pay').result
      const [i1, i2] = approvalIds(r1) as [string, string]
      const r2 = await s.respond({
        approvals: [
          { id: i1, approved: true, remember: 'session' },
          { id: i2, approved: false },
        ],
      }).result
      expect(r2.stop).toBe('complete')
      expect(log).toEqual(['pay:1'])
      expect(partState(r2.messages, 'd2')).toBe('output-denied')
      await agent.close()
    })
  }
})

describe('keys', () => {
  const scope = definePlugin({
    name: 'scope',
    setup: () => ({
      hooks: {
        'tool.grantScope': (_ctx, e) => (e.input as { kind?: string }).kind,
      },
    }),
  })

  test('tool.grantScope scoped keys combine with the principal key', async () => {
    const { agent, log, state } = setup(
      [call(1, 'k1', 'x'), { text: 'ok' }, call(2, 'k2', 'y'), call(3, 'k3', 'x'), { text: 'ok' }],
      { by: 'principal' },
      { plugins: [scope] },
    )
    const s = agent.session('s')
    const r1 = await s.send('pay', { principal: A }).result
    await s.respond({
      approvals: [{ id: approvalIds(r1)[0] as string, approved: true, remember: 'session' }],
    }).result
    expect((await state.get('s'))?.core.grants).toEqual({ [`a${NUL}pay${NUL}x`]: 'always' })
    // same principal, other scope: asks; the granted scope does not
    const r2 = await s.send('pay', { principal: A }).result
    expect(r2.stop).toBe('tool-pending')
    expect(approvalIds(r2)).toHaveLength(1)
    expect(log).toEqual(['pay:1'])
    await agent.close()
  })

  test('keys of the other mode are ignored, a call without a principal uses the session key', async () => {
    const { agent, log, state } = setup([call(1, 'm1'), { text: 'ok' }, call(2, 'm2')], {
      by: 'principal',
    })
    const s = agent.session('s')
    // no principal: plain key `pay`, there is none: asks
    const r1 = await s.send('pay').result
    expect(r1.stop).toBe('tool-pending')
    await s.respond({
      approvals: [{ id: approvalIds(r1)[0] as string, approved: true, remember: 'session' }],
    }).result
    expect((await state.get('s'))?.core.grants).toMatchObject({ pay: 'always' })
    // the stored plain key does not cover principal A, who has no grant
    const r2 = await s.send('pay', { principal: A }).result
    expect(r2.stop).toBe('tool-pending')
    expect(log).toEqual(['pay:1'])
    await agent.close()
  })

  test("by 'session' ignores principal keys stored by the other mode", async () => {
    const store = { messages: spyMessages(), state: spyState() }
    const mk = (by: 'session' | 'principal', steps: ScriptedStep[]) =>
      defineHarnessAgent({
        model: scriptedModel(steps),
        contextWindow: 100_000,
        storage: store,
        logger: silent,
        tools: {
          pay: tool({
            description: 'Pay',
            inputSchema: z.object({ amount: z.number() }),
            execute: async () => 'paid',
          }),
        },
        approval: { policy: { pay: 'user-approval' } },
        grants: { by },
      })
    const one = mk('principal', [call(1, 'p1'), { text: 'ok' }])
    const s1 = one.session('s')
    const r1 = await s1.send('pay', { principal: A }).result
    await s1.respond({
      approvals: [{ id: approvalIds(r1)[0] as string, approved: true, remember: 'session' }],
    }).result
    await one.close()
    const two = mk('session', [call(2, 'p2'), { text: 'ok' }])
    const r2 = await two.session('s').send('pay', { principal: A }).result
    expect(r2.stop).toBe('tool-pending')
    await two.close()
  })

  test('clearGrants(principal) clears only that principal', async () => {
    const { agent, state } = setup([call(1, 'g1'), { text: 'ok' }, call(2, 'g2'), { text: 'ok' }], {
      by: 'principal',
    })
    const s = agent.session('s')
    for (const p of [A, B]) {
      const r = await s.send('pay', { principal: p }).result
      await s.respond({
        approvals: [{ id: approvalIds(r)[0] as string, approved: true, remember: 'session' }],
      }).result
    }
    expect(Object.keys((await state.get('s'))?.core.grants ?? {}).sort()).toEqual([
      `a${NUL}pay`,
      `b${NUL}pay`,
    ])
    await s.clearGrants(A)
    expect((await state.get('s'))?.core.grants).toEqual({ [`b${NUL}pay`]: 'always' })
    await s.clearGrants(B)
    expect((await state.get('s'))?.core.grants).toBeUndefined()
    await agent.close()
  })
})

describe('validation', () => {
  test('a principal id with NUL is rejected', async () => {
    const { agent } = setup([{ text: 'x' }], { by: 'principal' })
    expect(() => agent.session('s', { principal: { id: `a${NUL}b` } })).toThrow()
    try {
      agent.session('s', { principal: { id: `a${NUL}b` } })
    } catch (error) {
      expect(isHarnessError(error, 'EH_INVALID_INPUT')).toBe(true)
    }
    const r = await agent.session('s2').send('hi', { principal: { id: `a${NUL}b` } }).result
    expect(r.stop).toBe('error')
    expect(r.error?.code).toBe('EH_INVALID_INPUT')
    await agent.close()
  })

  test('an unknown grants option is EH_CONFIG_INVALID', () => {
    for (const grants of [{ by: 'user' }, { applyAt: 'later' }]) {
      try {
        setup([{ text: 'x' }], grants as never)
        throw new Error('expected a throw')
      } catch (error) {
        expect(isHarnessError(error, 'EH_CONFIG_INVALID')).toBe(true)
      }
    }
  })
})
