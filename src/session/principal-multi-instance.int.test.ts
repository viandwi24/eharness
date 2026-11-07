/**
 * P62 C acceptance (ADR-0069): a turn enqueued with principal P on instance A is drained by
 * instance B, parks on an external tool, and is woken and continued on A. A plugin records
 * `ctx.principal?.id` in `turn.start`, `step.prepare`, a tool's `execute` and `turn.end` on both
 * instances: every record is P, although neither the instances nor the session know P otherwise.
 */
import { expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import type { InboxAdapter, Principal } from '../agent/session-types.ts'
import { definePlugin } from '../plugin/define-plugin.ts'
import { externalTool } from '../registry/external.ts'
import { inMemoryInbox, inMemoryMessages, inMemoryState } from '../storage/memory.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { until } from '../testing/test-utils.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const P: Principal = { id: 'ana', name: 'Ana' }

test('P enqueued on A, drained on B, parked, answered and continued on A: every hook and tool sees P', async () => {
  const inner = inMemoryInbox()
  const gate = { aClaims: false }
  const inbox: InboxAdapter = {
    ...inner,
    // A never claims while the gate is closed: B has to drain the item
    claim: (sessionId, owner, opts) =>
      owner.startsWith('inst-a') && !gate.aClaims
        ? Promise.resolve([])
        : inner.claim(sessionId, owner, opts),
  }
  const storage = { messages: inMemoryMessages(), state: inMemoryState(), inbox }
  const seen: string[] = []
  const make = (label: string, instanceId: string, model: ReturnType<typeof scriptedModel>) => {
    const id = (ctx: { principal: Principal | undefined }) => `${label}:${ctx.principal?.id ?? '-'}`
    const recorder = definePlugin({
      name: 'rec',
      setup: () => ({
        hooks: {
          'turn.start': (ctx) => void seen.push(`${id(ctx)}:start`),
          'step.prepare': (ctx) => void seen.push(`${id(ctx)}:step`),
          'turn.end': (ctx) => void seen.push(`${id(ctx)}:end`),
        },
      }),
    })
    const probe = (ctx: { principal: Principal | undefined }) =>
      tool({
        inputSchema: z.object({}),
        execute: async () => {
          seen.push(`${id(ctx)}:tool`)
          return 'probed'
        },
      })
    return defineHarnessAgent({
      model,
      contextWindow: 100_000,
      storage,
      inbox: { pollMs: 10 },
      recovery: { instanceId },
      logger: silent,
      plugins: [recorder],
      tools: {
        probe,
        ask: externalTool({
          description: 'wait for an outside result',
          inputSchema: z.object({ q: z.string() }),
          start: () => ({ correlationId: 'c1' }),
        }),
      },
    })
  }
  const a = make('a', 'inst-a', scriptedModel([{ text: 'continued on A' }]))
  const b = make(
    'b',
    'inst-b',
    scriptedModel([
      {
        toolCalls: [
          { toolName: 'probe', input: {} },
          { toolName: 'ask', input: { q: 'ready?' } },
        ],
      },
    ]),
  )
  const sessionA = a.session('s1')
  await b.session('s1').ready()
  await sessionA.ready()
  await sessionA.enqueue('please check', { principal: P })

  await until(
    'B parked the turn',
    async () => (await storage.state.get('s1'))?.core.pending !== undefined,
  )
  const pending = (await storage.state.get('s1'))?.core.pending
  expect(pending?.principal).toEqual(P)
  expect(seen.every((r) => r.startsWith('b:ana'))).toBe(true)
  expect(seen).toContain('b:ana:tool')

  // A (with no principal of its own) continues the turn B parked
  const resolved = await sessionA.resolveWait('w_call-0-1', { output: 'yes' })
  if (resolved.status !== 'continued') throw new Error('expected a continuation')
  expect((await resolved.run.result).stop).toBe('complete')

  const records = seen.filter((r) => r.startsWith('a:'))
  expect(records).toEqual(['a:ana:start', 'a:ana:step', 'a:ana:end'])
  expect(seen.filter((r) => !r.includes(':ana:'))).toEqual([])
  expect(seen.filter((r) => r.startsWith('b:')).map((r) => r.split(':')[2])).toEqual([
    'start',
    'step',
    'tool',
    'end',
  ])
  await a.close()
  await b.close()
})
