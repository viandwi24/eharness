import { describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod'
import { definePlugin, type HarnessContext, wrapPlugin } from '../index.ts'
import { fakeHarnessContext, resolvePlugin } from './plugin-resolve.ts'

const echo = tool({
  inputSchema: z.object({ text: z.string() }),
  execute: async ({ text }) => text,
})
const submit = { message: { id: 'm1', role: 'user', parts: [] } as never, via: 'send' as const }

const started: Array<{ principal: unknown; mode: unknown }> = []

function plugin() {
  return definePlugin({
    name: 'audit',
    setup: () => ({
      tools: { echo },
      instructions: [
        'static text',
        (ctx) => `plugin ${ctx.plugin.name}`,
        { text: 'by id', id: 'a' },
      ],
      hooks: {
        'input.submit': (ctx, e) => ({ block: { reason: `${ctx.plugin.name}:${e.via}` } }),
      },
    }),
    session: () => ({
      tools: {
        whoami: (ctx: HarnessContext) =>
          tool({
            description: `tool of ${ctx.plugin.name}`,
            inputSchema: z.object({}),
            execute: async () => ctx.principal?.id ?? 'nobody',
          }),
      },
      hooks: {
        'session.start': (ctx) => {
          started.push({ principal: ctx.principal?.id, mode: ctx.runtime.mode })
        },
      },
    }),
  })
}

describe('resolvePlugin', () => {
  test('returns static tools and ctx-function tools resolved with the context', async () => {
    const resolved = await resolvePlugin(plugin(), { ctx: { principal: { id: 'ana' } } })
    expect(resolved.name).toBe('audit')
    expect(Object.keys(resolved.tools)).toEqual(['echo', 'whoami'])
    expect(resolved.tools.echo).toBe(echo)
    expect(resolved.tools.whoami?.description).toBe('tool of audit')
    const run = resolved.tools.whoami?.execute as (input: unknown, options: unknown) => unknown
    expect(await run({}, {})).toBe('ana')
  })

  test('a hook runs with the event and its return value comes back', async () => {
    const resolved = await resolvePlugin(plugin())
    expect(await resolved.runHook('input.submit', submit)).toEqual({
      block: { reason: 'audit:send' },
    })
  })

  test('ctx overrides reach the hook, and the default ctx is used without them', async () => {
    const resolved = await resolvePlugin(plugin())
    started.length = 0
    await resolved.runHook('session.start')
    await resolved.runHook('session.start', undefined, {
      principal: { id: 'bo' },
      runtime: { mode: 'fast' },
    })
    expect(started).toEqual([
      { principal: undefined, mode: undefined },
      { principal: 'bo', mode: 'fast' },
    ])
  })

  test('hook names, instructions and services are listed as the core resolves them', async () => {
    const resolved = await resolvePlugin(plugin())
    expect(resolved.hooks).toEqual(['input.submit', 'session.start'])
    expect(resolved.instructions).toEqual(['static text', 'plugin audit', 'by id'])
    expect(resolved.toolSources).toEqual([])
    expect(await resolved.runHook('compaction.before', undefined as never)).toBeUndefined()
  })

  test('a wrapped plugin resolves with its overrides applied', async () => {
    const wrapped = wrapPlugin(plugin(), {
      hooks: {
        'input.submit': (ctx, _e, next) =>
          ctx.runtime.reason === undefined
            ? next()
            : { block: { reason: `overridden: ${String(ctx.runtime.reason)}` } },
      },
    })
    const resolved = await resolvePlugin(wrapped)
    expect(Object.keys(resolved.tools)).toEqual(['echo', 'whoami'])
    expect(await resolved.runHook('input.submit', submit)).toEqual({
      block: { reason: 'audit:send' },
    })
    expect(
      await resolved.runHook('input.submit', submit, { runtime: { reason: 'quota' } }),
    ).toEqual({ block: { reason: 'overridden: quota' } })
  })

  test('a plugin that requires a service resolves with the plugins that provide it', async () => {
    const store = definePlugin({
      name: 'store',
      provides: ['store'],
      session: () => ({ services: { store: { kind: 'memory' } } as never }),
    })
    const user = definePlugin({
      name: 'user',
      requires: ['store'],
      setup: () => ({ instructions: 'uses store' }),
    })
    await expect(resolvePlugin(user)).rejects.toMatchObject({ code: 'EH_SERVICE_MISSING' })
    const resolved = await resolvePlugin(user, { plugins: [store] })
    expect(resolved.instructions).toEqual(['uses store'])
  })

  test('a tool declared in both phases is refused as a duplicate', async () => {
    const twice = definePlugin({
      name: 'twice',
      setup: () => ({ tools: { echo } }),
      session: () => ({ tools: { echo } }),
    })
    await expect(resolvePlugin(twice)).rejects.toMatchObject({ code: 'EH_DUPLICATE_TOOL' })
  })
})

describe('fakeHarnessContext', () => {
  test('overrides replace fields; an unknown service throws EH_SERVICE_MISSING', () => {
    const ctx = fakeHarnessContext('audit', { principal: { id: 'ana' } })
    expect(ctx.plugin.name).toBe('audit')
    expect(ctx.principal?.id).toBe('ana')
    expect(() => (ctx.services as unknown as Record<string, unknown>).missing).toThrow()
  })

  test('plugin state is kept in memory', () => {
    const ctx = fakeHarnessContext('audit')
    ctx.state.set('count', 2)
    expect(ctx.state.get<number>('count')).toBe(2)
    ctx.state.set('count', undefined)
    expect(ctx.state.get('count')).toBeUndefined()
  })
})
