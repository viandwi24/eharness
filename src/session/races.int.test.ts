import { describe, expect, test } from 'bun:test'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import type { StateAdapter } from '../agent/session-types.ts'
import type { HarnessAgentConfig } from '../agent/types.ts'
import type { HarnessWarning } from '../errors.ts'
import { definePlugin } from '../plugin/define-plugin.ts'
import { type ScriptedPrompt, scriptedModel } from '../testing/scripted-model.ts'
import { spyMessages } from './int-kit.ts'
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
