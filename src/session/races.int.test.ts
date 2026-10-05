import { describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import type { StateAdapter } from '../agent/session-types.ts'
import type { HarnessAgentConfig } from '../agent/types.ts'
import type { HarnessWarning } from '../errors.ts'
import { definePlugin } from '../plugin/define-plugin.ts'
import { handleChatRequest } from '../stream/chat-request.ts'
import { type ScriptedPrompt, scriptedModel } from '../testing/scripted-model.ts'
import { collect, spyMessages } from './int-kit.ts'
import { defaultMemoryMessages, defaultMemoryState } from './memory-storage.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function setup(
  config: Partial<HarnessAgentConfig> & Pick<HarnessAgentConfig, 'model'>,
  storage: { messages?: ReturnType<typeof spyMessages>; state?: StateAdapter } = {},
) {
  const messages = storage.messages ?? spyMessages()
  const state = storage.state ?? defaultMemoryState()
  const warnings: HarnessWarning[] = []
  const agent = defineHarnessAgent({
    contextWindow: 100_000,
    storage: { messages, state },
    logger: silent,
    onWarning: (w) => warnings.push(w),
    ...config,
  })
  return { agent, messages, state, warnings }
}

/** A state adapter that answers after a random delay (0..maxMs). */
function slowState(inner: StateAdapter, maxMs: number, random: () => number): StateAdapter {
  const delay = () => sleep(Math.floor(random() * maxMs))
  return {
    async get(id) {
      await delay()
      return inner.get(id)
    },
    async set(id, value) {
      await delay()
      return inner.set(id, value)
    },
    async setIf(id, value, rev) {
      await delay()
      return (await inner.setIf?.(id, value, rev)) ?? false
    },
  }
}

/** Deterministic PRNG (mulberry32) so a failing iteration can be reproduced. */
function prng(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function userTexts(prompt: ScriptedPrompt | undefined): string[] {
  const out: string[] = []
  for (const message of prompt ?? []) {
    if (message.role !== 'user' || typeof message.content === 'string') continue
    for (const part of message.content) if (part.type === 'text') out.push(part.text)
  }
  return out
}

describe('item 1: single-flight context load', () => {
  test('stats() / inject() while a cold send() prepares never lose the user message or plugin state', async () => {
    for (let i = 0; i < 100; i++) {
      const random = prng(i + 1)
      const messages = spyMessages(defaultMemoryMessages())
      const innerState = defaultMemoryState()
      // history from an earlier instance: the session is cold for the new agent
      const first = setup(
        { model: scriptedModel([{ text: 'A0' }]) },
        { messages, state: innerState },
      )
      await first.agent.session('s1').send('Q0').result
      await first.agent.close()

      const marker = definePlugin({
        name: 'marker',
        setup: () => ({
          hooks: {
            'session.start': (ctx) => {
              ctx.state.set('opened', true)
            },
          },
        }),
      })
      const model = scriptedModel([{ text: 'A1' }])
      const env = setup(
        { model, plugins: [marker] },
        { messages, state: slowState(innerState, 4, random) },
      )
      const session = env.agent.session('s1')
      const order = random()
      const reads: Array<Promise<unknown>> = []
      const read = async () => {
        await sleep(Math.floor(random() * 3))
        reads.push(session.stats())
        await sleep(Math.floor(random() * 3))
        reads.push(session.inject('eh.event', { name: 'bg', text: 'BG' }))
      }
      let run: ReturnType<typeof session.send>
      if (order < 0.5) {
        run = session.send('hello')
        await read()
      } else {
        const pending = read()
        run = session.send('hello')
        await pending
      }
      const result = await run.result
      await Promise.all(reads)
      expect({ i, stop: result.stop }).toEqual({ i, stop: 'complete' })
      expect({ i, texts: userTexts(model.prompts[0]).includes('hello') }).toEqual({
        i,
        texts: true,
      })
      await env.agent.close()
      const stored = await innerState.get('s1')
      expect({ i, opened: stored?.plugins.marker?.opened }).toEqual({ i, opened: true })
    }
  }, 60_000)
})

describe('item 2: inject(next-step) during turn preparation', () => {
  test('delivered exactly once in step 0; a cold reload projects the same wire', async () => {
    const run = async (reload: boolean) => {
      const messages = spyMessages(defaultMemoryMessages())
      const innerState = defaultMemoryState()
      const model = scriptedModel([{ text: 'A0' }, { text: 'A1' }, { text: 'A2' }])
      const env = setup({ model }, { messages, state: slowState(innerState, 5, prng(7)) })
      let session = env.agent.session('s1')
      await session.send('Q0').result
      const main = session.send('go')
      const { message } = await session.inject(
        'eh.event',
        { name: 'ci', text: 'CI red' },
        { deliver: 'next-step' },
      )
      const result = await main.result
      expect(result.stop).toBe('complete')
      const step0 = JSON.stringify(model.prompts[1])
      expect(step0.split('CI red').length - 1).toBe(1)
      const stored = (
        (await messages.load({ sessionId: 's1' })) as Array<{
          id: string
          metadata?: { eharness?: { deliveredIn?: string } }
        }>
      ).find((m) => m.id === message.id)
      expect(stored?.metadata?.eharness?.deliveredIn).toBe(result.messageId as string)
      if (reload) {
        await env.agent.close()
        session = setup({ model }, { messages, state: innerState }).agent.session('s1')
      }
      await session.send('more').result
      const prompt = model.prompts[2]
      expect(JSON.stringify(prompt).split('CI red').length - 1).toBe(1)
      return prompt
    }
    const hot = await run(false)
    const cold = await run(true)
    expect(cold).toEqual(hot)
  })
})

describe('item 3: the stream ends only after the turn finalized', () => {
  test('after the stream ended, send() succeeds immediately', async () => {
    const turnEnd: string[] = []
    const probe = definePlugin({
      name: 'probe',
      setup: () => ({
        hooks: {
          'turn.end': async () => {
            await sleep(10)
            turnEnd.push('end')
          },
        },
      }),
    })
    const model = scriptedModel([{ text: 'A1' }, { text: 'A2' }])
    const { agent } = setup({ model, plugins: [probe] })
    const session = agent.session('s1')
    const chunks = await collect(session.send('one').stream)
    expect(chunks.at(-1)).toEqual({ type: 'finish' })
    expect(turnEnd).toEqual(['end'])
    expect(session.running).toBe(false)
    const second = session.send('two')
    expect((await second.result).stop).toBe('complete')
  })

  test('handleChatRequest never throws EH_SESSION_BUSY: a failed run answering 409', async () => {
    const model = scriptedModel([{ text: 'A1', delayMs: 10 }])
    const { agent } = setup({ model })
    const session = agent.session('s1')
    const first = session.send('one')
    const body = {
      messages: [
        { id: 'u2', role: 'user' as const, parts: [{ type: 'text' as const, text: 'two' }] },
      ],
    }
    const run = handleChatRequest(session, body)
    const result = await run.result
    expect(result.stop).toBe('error')
    expect(result.error?.code).toBe('EH_SESSION_BUSY')
    const response = run.toResponse()
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: { code: 'EH_SESSION_BUSY', message: expect.any(String) },
    })
    await first.result
  })

  test("ifBusy: 'wait' runs send() after the running turn; session.idle()", async () => {
    const model = scriptedModel([{ text: 'A1', delayMs: 5 }, { text: 'A2' }])
    const { agent } = setup({ model })
    const session = agent.session('s1')
    const first = session.send('one')
    const second = session.send('two', { ifBusy: 'wait' })
    const [a, b] = await Promise.all([first.result, second.result])
    expect(a.stop).toBe('complete')
    expect(b.stop).toBe('complete')
    expect(userTexts(model.prompts[1])).toEqual(['one', 'two'])
    await session.idle()
    expect(session.running).toBe(false)
  })

  test("ifBusy: 'wait' honours abortSignal while waiting", async () => {
    const model = scriptedModel([{ text: 'A1', delayMs: 5 }])
    const { agent, messages } = setup({ model })
    const session = agent.session('s1')
    const first = session.send('one')
    const controller = new AbortController()
    const second = session.send('two', { ifBusy: 'wait', abortSignal: controller.signal })
    controller.abort()
    expect((await second.result).stop).toBe('aborted')
    await first.result
    await session.idle()
    const stored = await messages.load({ sessionId: 's1' })
    expect(stored.length).toBe(2)
  })

  test("respond({ ifBusy: 'wait' }) waits for the running turn, then answers", async () => {
    const pay = tool({
      inputSchema: z.object({ amount: z.number() }),
      execute: async ({ amount }) => `paid ${amount}`,
    })
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'pay', input: { amount: 5 } }] },
      { text: 'ok', delayMs: 5 },
      { text: 'after' },
    ])
    const { agent } = setup({
      model,
      tools: { pay },
      approval: { policy: { pay: 'user-approval' } },
    })
    const session = agent.session('s1')
    const first = await session.send('pay').result
    const approvalId = first.pending?.approvals[0]?.approvalId as string
    const running = session.respond({ approvals: [{ id: approvalId, approved: true }] })
    // a second, identical answer waits; the pending state is gone by then: a run error
    const waited = session.respond(
      { approvals: [{ id: approvalId, approved: true }] },
      { ifBusy: 'wait' },
    )
    expect((await running.result).stop).toBe('complete')
    const late = await waited.result
    expect(late.stop).toBe('error')
    expect(late.error?.code).toBe('EH_INVALID_INPUT')
  })

  test('a waiting send() never denies approvals created by the turn it waited for', async () => {
    const pay = tool({
      inputSchema: z.object({ amount: z.number() }),
      execute: async ({ amount }) => `paid ${amount}`,
    })
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'pay', input: { amount: 5 } }], delayMs: 5 },
      { text: 'paid' },
      { text: 'next' },
    ])
    const { agent } = setup({
      model,
      tools: { pay },
      approval: { policy: { pay: 'user-approval' } },
    })
    const session = agent.session('s1')
    const first = session.send('pay')
    const waited = session.send('next', { ifBusy: 'wait' })
    const pending = (await first.result).pending
    expect(pending).toBeDefined()
    await sleep(10)
    expect((await session.stats()).pending).toEqual(pending ?? null)
    const approvalId = pending?.approvals[0]?.approvalId as string
    expect(
      (await session.respond({ approvals: [{ id: approvalId, approved: true }] }).result).stop,
    ).toBe('complete')
    expect((await waited.result).stop).toBe('complete')
  })
})

describe('item 4: steer at max-steps', () => {
  test('the wrap-up step takes no input; the steer becomes a queued send turn', async () => {
    const work = tool({
      inputSchema: z.object({ n: z.number() }),
      execute: async ({ n }) => {
        await sleep(30)
        return `worked ${n}`
      },
    })
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'work', input: { n: 1 } }] },
      { text: 'wrap-up summary' },
      { text: 'answer to steer' },
    ])
    const { agent } = setup({ model, tools: { work }, loop: { maxSteps: 1 } })
    const session = agent.session('s1')
    const reader = session.events().getReader()
    const main = session.send('go')
    await sleep(10)
    session.send('STEER', { ifBusy: 'steer' })
    expect((await main.result).stop).toBe('max-steps')
    expect(JSON.stringify(model.prompts[1])).not.toContain('STEER')
    await session.idle()
    expect(userTexts(model.prompts[2]).at(-1)).toBe('STEER')
    await session.close()
    const starts: Array<{ queued: boolean }> = []
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      if (next.value.type === 'turn-start') starts.push(next.value as { queued: boolean })
    }
    expect(starts.map((e) => e.queued)).toEqual([false, true])
  })
})

describe('item 5: messages() paging skips hidden messages', () => {
  const textOf = (m: { parts: Array<{ type: string; text?: string }> }) =>
    m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') || 'R'

  test('a page whose newest messages are hidden still returns `limit` visible ones (hot and cold)', async () => {
    const messages = spyMessages(defaultMemoryMessages())
    const state = defaultMemoryState()
    const model = scriptedModel([{ text: 'A1' }, { text: 'A2' }, { text: 'A2b' }])
    const env = setup({ model }, { messages, state })
    const session = env.agent.session('s1')
    await session.send('Q1').result
    await session.send('Q2').result
    const stored = (await messages.load({ sessionId: 's1' })) as Array<{ id: string }>
    const q2 = stored[2]?.id as string
    const edited = await session.edit(q2, 'Q2b').result
    const rewindId = edited.messages[0]?.id as string
    // ids: Q1 A1 Q2 A2 R Q2b A2b — the two messages right before R are hidden
    const hot = await session.messages({ beforeId: rewindId, limit: 2 })
    expect(hot.map(textOf)).toEqual(['Q1', 'A1'])
    expect((await session.messages({ limit: 4 })).map(textOf)).toEqual(['A1', 'R', 'Q2b', 'A2b'])
    await env.agent.close()
    const cold = setup({ model }, { messages, state }).agent.session('s1')
    expect((await cold.messages({ beforeId: rewindId, limit: 2 })).map(textOf)).toEqual([
      'Q1',
      'A1',
    ])
    expect((await cold.messages({ limit: 4 })).map(textOf)).toEqual(['A1', 'R', 'Q2b', 'A2b'])
  })
})
