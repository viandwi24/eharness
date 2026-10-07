/**
 * `wrapPlugin()` (spec 01 §2.1): delegation by default, session / setup / hook interception with
 * `next`, per-request configuration from `ctx.runtime`, boot validation, shipped plugins.
 */
import { describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod/v4'
import { memoryFs } from '../filesystem/memory.ts'
import { filesystem } from '../filesystem/plugin.ts'
import { approvalGuard } from '../guard/index.ts'
import {
  defineDataPart,
  defineHarnessAgent,
  definePlugin,
  type HarnessAgentConfig,
  isHarnessError,
  wrapPlugin,
} from '../index.ts'
import { memory } from '../memory/index.ts'
import { memoryMessages, memoryState } from '../storage/memory.ts'
import { scriptedModel } from '../testing/scripted-model.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

function agentOf(
  plugins: NonNullable<HarnessAgentConfig['plugins']>,
  config: Partial<HarnessAgentConfig> = {},
  script: Parameters<typeof scriptedModel>[0] = [{ text: 'ok' }],
) {
  const model = scriptedModel(script)
  const agent = defineHarnessAgent({
    model,
    contextWindow: 100_000,
    storage: { messages: memoryMessages(), state: memoryState() },
    logger: silent,
    plugins,
    ...config,
  })
  return { agent, model }
}

const systemText = (model: { prompts: unknown[] }, index = 0): string =>
  JSON.stringify(model.prompts[index])

/** A plugin with every kind of contribution, recording hook calls into `log`. */
function base(log: string[]) {
  return definePlugin({
    name: 'base',
    version: '1.2.3',
    provides: ['basesvc'],
    dataParts: { note: defineDataPart({ schema: z.object({ text: z.string() }) }) },
    setup: () => ({
      instructions: 'BASE-STATIC',
      hooks: { 'turn.start': () => void log.push('base:setup:turn.start') },
    }),
    session: () => ({
      instructions: 'BASE-SESSION',
      services: { basesvc: 'svc' } as never,
      hooks: { 'turn.start': () => void log.push('base:session:turn.start') },
    }),
  })
}

describe('wrapPlugin', () => {
  test('without overrides it delegates everything and keeps the definition', async () => {
    const log: string[] = []
    const inner = base(log)
    const wrapped = wrapPlugin(inner)
    expect(wrapped.name).toBe('base')
    expect(wrapped['~def'].version).toBe('1.2.3')
    expect(wrapped['~def'].provides).toEqual(['basesvc'])
    expect(Object.keys(wrapped['~def'].dataParts ?? {})).toEqual(['note'])
    const { agent, model } = agentOf([wrapped])
    await agent.session('s').send('hi').result
    expect(systemText(model)).toContain('BASE-STATIC')
    expect(systemText(model)).toContain('BASE-SESSION')
    expect(log).toEqual(['base:setup:turn.start', 'base:session:turn.start'])
    await agent.close()
  })

  test('hook overrides wrap each registration; order is unchanged; next can replace args', async () => {
    const log: string[] = []
    const wrapped = wrapPlugin(base(log), {
      hooks: {
        'turn.start': async (_ctx, e, next) => {
          log.push('wrap:before')
          await next()
          log.push(`wrap:after:${e.kind}`)
        },
      },
    })
    const { agent } = agentOf([wrapped])
    await agent.session('s').send('hi').result
    expect(log).toEqual([
      'wrap:before',
      'base:setup:turn.start',
      'wrap:after:send',
      'wrap:before',
      'base:session:turn.start',
      'wrap:after:send',
    ])
    await agent.close()
  })

  test('an override of a hook the inner plugin lacks is added once, next resolves undefined', async () => {
    const seen: unknown[] = []
    const inner = definePlugin({ name: 'plain', setup: () => ({ instructions: 'PLAIN' }) })
    const wrapped = wrapPlugin(inner, {
      hooks: {
        'turn.end': async (_ctx, _e, next) => {
          seen.push(await next())
        },
      },
    })
    const { agent } = agentOf([wrapped])
    await agent.session('s').send('hi').result
    expect(seen).toEqual([undefined])
    await agent.close()
  })

  test('session override: next(), modify the contribution, skip the inner phase', async () => {
    const log: string[] = []
    const wrapped = wrapPlugin(base(log), {
      session: async (ctx, next) => {
        if (ctx.runtime.skip === true) return { services: { basesvc: 'replaced' } as never }
        const inner = await next()
        return { ...inner, instructions: `${String(inner?.instructions)}+EXTRA` }
      },
    })
    const { agent, model } = agentOf([wrapped])
    await agent.session('a').send('hi').result
    expect(systemText(model)).toContain('BASE-SESSION+EXTRA')
    await agent.session('b', { runtime: { skip: true } }).send('hi').result
    expect(systemText(model, 1)).not.toContain('BASE-SESSION')
    expect(systemText(model, 1)).toContain('BASE-STATIC')
    await agent.close()
  })

  test('setup override intercepts the agent phase', async () => {
    const wrapped = wrapPlugin(
      definePlugin({ name: 'p', setup: () => ({ instructions: 'ONE' }) }),
      { setup: (_ctx, next) => ({ ...next(), instructions: 'TWO' }) },
    )
    const { agent, model } = agentOf([wrapped])
    await agent.session('s').send('hi').result
    expect(systemText(model)).toContain('TWO')
    expect(systemText(model)).not.toContain('ONE')
    await agent.close()
  })

  test('per-request options: next.using builds the inner plugin from ctx.runtime', async () => {
    const make = (label: string) =>
      definePlugin({ name: 'cfg', session: () => ({ instructions: `LABEL:${label}` }) })
    const wrapped = wrapPlugin(make('default'), {
      session: (ctx, next) =>
        ctx.runtime.label === undefined ? next() : next.using(make(String(ctx.runtime.label))),
    })
    const { agent, model } = agentOf([wrapped])
    await agent.session('a').send('hi').result
    await agent.session('b', { runtime: { label: 'custom' } }).send('hi').result
    expect(systemText(model, 0)).toContain('LABEL:default')
    expect(systemText(model, 1)).toContain('LABEL:custom')
    await agent.close()
  })

  test('wrapping twice works and each layer sees the one below', async () => {
    const log: string[] = []
    const once = wrapPlugin(base(log), {
      hooks: {
        'turn.start': async (_c, _e, next) => {
          log.push('L1')
          await next()
        },
      },
    })
    const twice = wrapPlugin(once, {
      hooks: {
        'turn.start': async (_c, _e, next) => {
          log.push('L2')
          await next()
        },
      },
    })
    const { agent } = agentOf([twice])
    await agent.session('s').send('hi').result
    expect(log.slice(0, 3)).toEqual(['L2', 'L1', 'base:setup:turn.start'])
    await agent.close()
  })

  test('boot validation still applies: duplicate names, services, order', () => {
    const a = base([])
    const wrapped = wrapPlugin(a)
    try {
      defineHarnessAgent({
        model: scriptedModel([]),
        contextWindow: 1000,
        plugins: [a, wrapped],
      })
      throw new Error('expected a throw')
    } catch (error) {
      expect(isHarnessError(error)).toBe(true)
    }
    const needs = definePlugin({ name: 'needs', requires: ['basesvc'] })
    try {
      defineHarnessAgent({
        model: scriptedModel([]),
        contextWindow: 1000,
        plugins: [needs, wrapped],
      })
      throw new Error('expected a throw')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('EH_PLUGIN_ORDER')
    }
    expect(() => wrapPlugin(a, { name: 'eh' as never })).toThrow()
  })

  test('a renamed wrapper is a different plugin (name, namespace)', () => {
    const wrapped = wrapPlugin(base([]), { name: 'renamed' })
    expect(wrapped.name).toBe('renamed')
  })

  test('wraps approvalGuard: per-request judge model and a tighten-only combination', async () => {
    const judgeA = scriptedModel([{ text: '{"decision":"allow","reason":"fine."}' }])
    const judgeB = scriptedModel([{ text: '{"decision":"deny","reason":"nope."}' }])
    const sent: string[] = []
    const guard = wrapPlugin(approvalGuard({ model: judgeA }), {
      session: (ctx, next) =>
        ctx.runtime.judge === undefined
          ? next()
          : next.using(approvalGuard({ model: ctx.runtime.judge as never })),
      hooks: {
        'tool.approve': async (_ctx, _e, next) => {
          const status = await next()
          // never loosen: only pass the guard's own answer through
          return status === 'approved' ? 'not-applicable' : status
        },
      },
    })
    const send = (to: string) => ({ toolCalls: [{ toolName: 'send_email', input: { to } }] })
    const { agent } = agentOf(
      [guard],
      {
        approval: { risk: { external: 'approved' } },
        tools: {
          send_email: tool({
            description: 'Send an email.',
            inputSchema: z.object({ to: z.string() }),
            metadata: { risk: 'external' },
            execute: async ({ to }) => {
              sent.push(to)
              return `Sent to ${to}`
            },
          }),
        },
      },
      [send('a@x.com'), { text: 'done' }, send('b@x.com'), { text: 'done' }, { text: 'done' }],
    )
    await agent.session('s1').send('mail a').result
    expect(judgeA.calls).toHaveLength(1)
    expect(sent).toEqual(['a@x.com'])
    await agent.session('s2', { runtime: { judge: judgeB } }).send('mail b').result
    expect(judgeB.calls).toHaveLength(1)
    expect(judgeA.calls).toHaveLength(1)
    expect(sent).toEqual(['a@x.com'])
    await agent.close()
  })

  test('wraps memory: roots stay, the wrapper adds its own instructions per session', async () => {
    const fs = memoryFs({ '/memories/org/x.md': 'org fact' })
    const wrapped = wrapPlugin(memory({ roots: () => [{ path: '/memories/org', label: 'org' }] }), {
      session: async (ctx, next) => {
        const inner = await next()
        return {
          ...inner,
          instructions: [
            ...[inner?.instructions ?? []].flat(),
            `TENANT:${String(ctx.runtime.tenant)}`,
          ],
        }
      },
    })
    expect(wrapped.name).toBe('memory')
    const { agent, model } = agentOf([filesystem({ fs, hiddenPrefixes: ['/memories'] }), wrapped])
    await agent.session('s', { runtime: { tenant: 't1' } }).send('hi').result
    expect(systemText(model)).toContain('TENANT:t1')
    expect(systemText(model)).toContain('/memories/org')
    await agent.close()
  })
})
