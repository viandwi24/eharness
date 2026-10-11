/**
 * Regression tests of the 0.8 core robustness review: throwing handlers, concurrent inject,
 * expiry backoff, ghost rewinds, stream log retention, listener leaks, uncloneable tool output.
 */

import { describe, expect, test } from 'bun:test'
import { getEventListeners } from 'node:events'
import { tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent, definePlugin } from '../index.ts'
import { externalTool } from '../registry/external.ts'
import { inMemoryMessages, inMemoryState, inMemoryStreamLog } from '../storage/memory.ts'
import { createStreamLogWriter, resolveStreamLogOptions } from '../stream/log-writer.ts'
import { createTurnBuffer } from '../stream/run.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import { until } from '../testing/test-utils.ts'
import { spyMessages, spyState } from './test-kit.ts'

const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const timeout = <T>(p: Promise<T>, ms = 2000): Promise<T | 'HUNG'> =>
  Promise.race([p, new Promise<'HUNG'>((r) => setTimeout(() => r('HUNG'), ms))])

describe('throwing onWarning / logger never break a turn (A1)', () => {
  test('a failing turn.end hook with a throwing onWarning and logger still ends the turn', async () => {
    const plugin = definePlugin({
      name: 'p',
      setup: () => ({
        hooks: {
          'turn.end': async () => {
            throw new Error('boom')
          },
        },
      }),
    } as never)
    const agent = defineHarnessAgent({
      model: scriptedModel([{ text: 'hi' }, { text: 'again' }]),
      contextWindow: 100_000,
      plugins: [plugin],
      storage: { messages: inMemoryMessages(), state: inMemoryState() },
      logger: {
        debug() {},
        info() {},
        warn() {
          throw new Error('logger bug')
        },
        error() {
          throw new Error('logger bug')
        },
      },
      onWarning: () => {
        throw new Error('handler bug')
      },
    } as never)
    const s = agent.session('s')
    const result = await timeout(s.send('x').result)
    expect(result).not.toBe('HUNG')
    expect(s.running).toBe(false)
    // the next turn starts: the session is not busy forever
    expect(await timeout(s.send('y').result)).not.toBe('HUNG')
    await agent.close()
  })
})

describe('inject({ key }) (A2)', () => {
  test('concurrent injects with the same key store exactly one message', async () => {
    const agent = defineHarnessAgent({
      model: scriptedModel([{ text: 'hi' }]),
      storage: { messages: inMemoryMessages(), state: inMemoryState() },
      logger: quiet,
    } as never)
    const s = agent.session('s1') as any
    const payload = { name: 'x', text: 'report' }
    const [a, b] = await Promise.all([
      s.inject('eh.event', payload, { key: 'k1' }),
      s.inject('eh.event', payload, { key: 'k1' }),
    ])
    expect(a.message.id).toBe(b.message.id)
    expect((await s.messages()).length).toBe(1)
    await agent.close()
  })
})

describe('wait-timeout expiry backoff (A3)', () => {
  test('a failing state store is not retried in a hot loop', async () => {
    const inner = inMemoryState()
    let failing = false
    let writes = 0
    const state: any = {
      get: (id: string) => inner.get(id),
      set: async (id: string, s: any) => {
        if (failing) {
          writes++
          throw new Error('db down')
        }
        return inner.set(id, s)
      },
      setIf: async (id: string, s: any, r: any) => {
        if (failing) {
          writes++
          throw new Error('db down')
        }
        return inner.setIf?.(id, s, r)
      },
    }
    const build = externalTool({
      description: 'b',
      inputSchema: z.object({ ref: z.string() }),
      timeoutMs: 20,
    } as never)
    const agent = defineHarnessAgent({
      model: scriptedModel([
        { toolCalls: [{ toolName: 'build', input: { ref: 'a' } }] },
        { text: 'x' },
      ]),
      contextWindow: 100_000,
      tools: { build },
      storage: { messages: inMemoryMessages(), state },
      logger: quiet,
    } as never)
    const s = agent.session('s1')
    await s.send('go').result
    failing = true
    await new Promise((r) => setTimeout(r, 1000))
    // 250 ms, 500 ms ...: a handful of attempts, not hundreds
    expect(writes).toBeLessThan(15)
    failing = false
    await agent.close()
  })
})

describe('failed regenerate leaves no ghost rewind (A7)', () => {
  test('history stays visible when the rewind marker cannot be saved', async () => {
    const messages = spyMessages()
    const state = spyState()
    const agent = defineHarnessAgent({
      model: scriptedModel([{ text: 'a1' }, { text: 'a2' }, { text: 'a3' }]),
      contextWindow: 100_000,
      storage: { messages, state },
      logger: quiet,
    } as never)
    const s = agent.session('s')
    await s.send('q1').result
    await s.send('q2').result
    const before = (await s.messages()).map((m) => m.id)
    messages.failSave = (ms: any[]) => ms.some((m) => m.metadata?.eharness?.kind === 'eh.rewind')
    const r = await s.regenerate().result
    expect(r.stop).toBe('error')
    messages.failSave = undefined
    expect((await state.get('s'))?.core.rewinds ?? []).toEqual([])
    const after = (await s.messages()).map((m) => m.id)
    for (const id of before) expect(after).toContain(id) // the old answer is not hidden
    await agent.close()
  })
})

describe('stream log retention (A8)', () => {
  test('a quiet turn that outlives the retention is restarted, not lost', async () => {
    let t = 0
    const adapter = inMemoryStreamLog({ retentionMs: 1000, now: () => t })
    const buffer = createTurnBuffer()
    const warnings: string[] = []
    const key = { sessionId: 's', turnId: 't' }
    const w = createStreamLogWriter({
      adapter,
      key,
      buffer,
      options: resolveStreamLogOptions({ flushMs: 5 }),
      warn: (x) => warnings.push(x.code),
    })
    w.start()
    buffer.push({ type: 'start', messageId: 'm' } as never)
    await new Promise((r) => setTimeout(r, 30))
    t = 5000 // quiet for longer than the retention (a long tool call)
    buffer.push({ type: 'finish' } as never)
    buffer.close()
    await w.finish('done')
    const read = await adapter.read(key, 0)
    expect(read.status).toBe('done')
    expect(read.chunks.length).toBe(2)
    expect(warnings).toEqual([])
  })

  test('inMemoryStreamLog does not create a log on a gap', async () => {
    const adapter = inMemoryStreamLog()
    const key = { sessionId: 's', turnId: 'gap' }
    await expect(adapter.append(key, [{ a: 1 }], { at: 3 })).rejects.toThrow(/gap/)
    expect((await adapter.read(key, 0)).status).toBe('missing')
  })

  test('the writer refreshes the retention of a quiet log (keep-alive)', async () => {
    const expired: number[] = []
    const inner = inMemoryStreamLog()
    const adapter = {
      ...inner,
      expire: async (k: any, ttl: number) => {
        expired.push(ttl)
        return inner.expire?.(k, ttl)
      },
    }
    const buffer = createTurnBuffer()
    const w = createStreamLogWriter({
      adapter,
      key: { sessionId: 's', turnId: 'k' },
      buffer,
      options: resolveStreamLogOptions({ flushMs: 5, retentionMs: 30 }),
      warn: () => {},
    })
    w.start()
    buffer.push({ type: 'start', messageId: 'm' } as never)
    await until('the keep-alive refreshed the retention', () => expired.length > 0)
    expect(expired.length).toBeGreaterThan(0)
    buffer.close()
    await w.finish('done')
  })
})

describe('listeners and outputs (A10)', () => {
  test("ifBusy:'wait' leaves no abort listener on a shared signal", async () => {
    const agent = defineHarnessAgent({
      model: scriptedModel(Array.from({ length: 10 }, () => ({ text: 'ok' }))),
      contextWindow: 100_000,
      storage: { messages: inMemoryMessages(), state: inMemoryState() },
      logger: quiet,
    } as never)
    const s = agent.session('s')
    const shared = new AbortController()
    const first = s.send('0')
    const runs = []
    for (let i = 1; i <= 5; i++)
      runs.push(s.send(String(i), { ifBusy: 'wait', abortSignal: shared.signal }))
    await Promise.all([first.result, ...runs.map((r) => r.result)])
    expect(getEventListeners(shared.signal, 'abort').length).toBe(0)
    await agent.close()
  })

  test('a tool output that structuredClone cannot copy does not kill the turn', async () => {
    const t = tool({
      description: 'x',
      inputSchema: z.object({}),
      execute: async () => ({ ok: 1, fn: () => 1 }),
    } as never)
    const agent = defineHarnessAgent({
      model: scriptedModel([{ toolCalls: [{ toolName: 't', input: {} }] }, { text: 'done' }]),
      contextWindow: 100_000,
      tools: { t },
      storage: { messages: inMemoryMessages(), state: inMemoryState() },
      logger: quiet,
    } as never)
    const result = await agent.session('s').send('go').result
    expect(result.stop).toBe('complete')
    await agent.close()
  })
})
