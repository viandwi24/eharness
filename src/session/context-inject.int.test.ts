import { describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import { isHarnessError } from '../errors.ts'
import { definePlugin } from '../plugin/define-plugin.ts'
import type { HarnessContext } from '../plugin/types.ts'
import { scriptedModel } from '../testing/scripted-model.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function probe(
  capture: { ctx?: HarnessContext },
  emit?: (ctx: HarnessContext) => Promise<unknown>,
) {
  return definePlugin({
    name: 'probe',
    session(ctx) {
      capture.ctx = ctx as unknown as HarnessContext
      return {
        tools: {
          notify: tool({
            description: 'Emit an event from inside the tool',
            inputSchema: z.object({}),
            execute: async () => {
              await emit?.(ctx as unknown as HarnessContext)
              return 'sent'
            },
          }),
        },
      }
    },
  })
}

describe('ctx.session.inject', () => {
  test('from a tool with deliver next-step: lands at the next step boundary of the running turn', async () => {
    const capture: { ctx?: HarnessContext } = {}
    const model = scriptedModel([
      { toolCalls: [{ toolName: 'notify', input: {} }] },
      { text: 'noted' },
    ])
    const agent = defineHarnessAgent({
      model,
      contextWindow: 100_000,
      logger: silent,
      plugins: [
        probe(capture, (ctx) =>
          ctx.session.inject(
            'eh.event',
            { name: 'ping', text: 'hello from a tool' },
            { deliver: 'next-step' },
          ),
        ),
      ],
    })
    const session = agent.session('s1')
    expect((await session.send('go').result).stop).toBe('complete')
    expect(JSON.stringify(model.prompts[1])).toContain('hello from a tool')
    const stored = JSON.stringify(await session.messages())
    expect(stored).toContain('hello from a tool')
    await agent.close()
  })

  test('wake: true on an idle session starts a turn and returns its run', async () => {
    const capture: { ctx?: HarnessContext } = {}
    const model = scriptedModel([{ text: 'first' }, { text: 'woken' }])
    const agent = defineHarnessAgent({
      model,
      contextWindow: 100_000,
      logger: silent,
      plugins: [probe(capture)],
    })
    const session = agent.session('s1')
    await session.send('hi').result
    const out = await (capture.ctx as HarnessContext).session.inject(
      'eh.event',
      { name: 'job', text: 'job finished' },
      { wake: true },
    )
    expect(out.message).toBeDefined()
    expect(out.run).toBeDefined()
    const result = await out.run?.result
    expect(result?.stop).toBe('complete')
    expect(JSON.stringify(model.prompts[1])).toContain('job finished')
    await agent.close()
  })

  test('validates the kind and the payload like session.inject, and rejects after close', async () => {
    const capture: { ctx?: HarnessContext } = {}
    const agent = defineHarnessAgent({
      model: scriptedModel([{ text: 'a' }]),
      contextWindow: 100_000,
      logger: silent,
      plugins: [probe(capture)],
    })
    const session = agent.session('s1')
    await session.send('hi').result
    const ctx = capture.ctx as HarnessContext
    const unknown = await ctx.session.inject('nope', {}).catch((e: unknown) => e)
    expect(isHarnessError(unknown) && unknown.code).toBe('EH_INVALID_INPUT')
    const invalid = await ctx.session.inject('eh.event', { name: 1 }).catch((e: unknown) => e)
    expect(isHarnessError(invalid) && invalid.code).toBe('EH_INVALID_INPUT')
    await session.close()
    await sleep(5)
    const closed = await ctx.session
      .inject('eh.event', { name: 'a', text: 'b' })
      .catch((e: unknown) => e)
    expect(isHarnessError(closed) && closed.code).toBe('EH_SESSION_CLOSED')
    await agent.close()
  })

  test('ctx.session.parent reads the stored link when the session was opened without options', async () => {
    const capture: { ctx?: HarnessContext } = {}
    const agent = defineHarnessAgent({
      model: scriptedModel([{ text: 'a' }]),
      contextWindow: 100_000,
      logger: silent,
      plugins: [probe(capture)],
    })
    await agent.session('parent').send('hi').result
    await agent
      .session('child', { parent: { sessionId: 'parent', turnId: 't', toolCallId: 'c', depth: 1 } })
      .ready()
    await agent.closeSession('child')
    await agent.session('child').ready()
    expect(capture.ctx?.session.parent).toEqual({
      sessionId: 'parent',
      turnId: 't',
      toolCallId: 'c',
      depth: 1,
    })
    await agent.close()
  })
})
