import { describe, expect, test } from 'bun:test'
import { jsonSchema, tool } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod/v4'
import { type HarnessErrorCode, isHarnessError } from '../errors.ts'
import { defineDataPart } from '../messages/data-parts.ts'
import { defineMessageKind } from '../messages/kinds.ts'
import { definePlugin } from '../plugin/define-plugin.ts'
import { defineToolSource } from '../registry/tool-source.ts'
import { defineHarnessAgent } from './define-agent.ts'
import { getAgentInternals } from './internals.ts'
import type { HarnessAgentConfig } from './types.ts'

const model = new MockLanguageModelV4()
const echo = tool({
  inputSchema: z.object({ text: z.string() }),
  execute: async ({ text }) => text,
})
const part = defineDataPart({ schema: z.object({ n: z.number() }) })
const kind = defineMessageKind({ role: 'user', schema: z.object({ text: z.string() }) })
const skill = (name: string) => ({ name, description: `${name} skill`, content: 'body' })

/** Assert that `fn` throws a HarnessError with `code` whose message contains every `owner`. */
function expectBootError(fn: () => unknown, code: HarnessErrorCode, owners: string[]): void {
  let thrown: unknown
  try {
    fn()
  } catch (error) {
    thrown = error
  }
  expect(isHarnessError(thrown, code)).toBe(true)
  for (const owner of owners) expect((thrown as Error).message).toContain(owner)
}

const agent = (config: Omit<HarnessAgentConfig, 'model'>) => () =>
  defineHarnessAgent({ model, ...config })

describe('defineHarnessAgent: normalization', () => {
  test('root plugin app comes first; registries in plugin order', () => {
    const order: string[] = []
    const a = definePlugin({
      name: 'a',
      dataParts: { change: part },
      messageKinds: { report: kind },
      provides: ['fs'],
      setup: (ctx) => {
        order.push(`a:${ctx.agentId}`)
        expect(ctx.has.dataPart('data-a.change')).toBe(true)
        expect(ctx.has.dataPart('data-invoice')).toBe(true)
        expect(ctx.has.dataPart('a.change')).toBe(false)
        expect(ctx.has.service('fs')).toBe(true)
        return {
          instructions: 'from a',
          tools: { a_tool: echo },
          skills: [skill('a-skill')],
          hooks: { 'turn.start': () => {} },
        }
      },
    })
    const b = definePlugin({
      name: 'b',
      requires: ['fs'],
      setup: () => {
        order.push('b')
        return { instructions: [{ text: () => 'dyn', refresh: 'turn' }] }
      },
    })
    const created = defineHarnessAgent({
      id: 'x',
      model,
      instructions: ['app first', () => 'session text'],
      tools: [{ echo }, defineToolSource({ id: 'src', list: () => ({}) })],
      skills: [skill('app-skill')],
      dataParts: { invoice: part },
      messageKinds: { reminder: kind },
      plugins: [a, b],
    })
    expect(created.id).toBe('x')
    expect(order).toEqual(['a:x', 'b'])
    const internals = getAgentInternals(created)
    expect(internals.plugins.map((p) => p.name)).toEqual(['app', 'a', 'b'])
    expect(internals.statics.instructions.map((i) => [i.owner, i.kind])).toEqual([
      ['app', 'static'],
      ['app', 'dynamic'],
      ['a', 'static'],
      ['b', 'dynamic'],
    ])
    expect(internals.statics.tools.map((t) => `${t.owner}:${t.name}`)).toEqual([
      'app:echo',
      'a:a_tool',
    ])
    expect(internals.statics.toolSources.map((s) => s.source.id)).toEqual(['src'])
    expect(internals.statics.skills.map((s) => s.skill.name)).toEqual(['app-skill', 'a-skill'])
    expect(internals.statics.hooks.map((h) => h.owner)).toEqual(['a'])
    expect(internals.messages.dataPart('data-invoice')?.owner).toBe('app')
    expect(internals.messages.kind('reminder')?.owner).toBe('app')
    expect(internals.messages.dataPart('data-a.change')?.owner).toBe('a')
    expect(internals.messages.kind('a.report')?.owner).toBe('a')
    expect(internals.messages.kind('eh.compaction')?.owner).toBe('eh')
    expect(internals.services.get('fs')).toBe('a')
  })

  test('defaults; session() returns a live session without I/O', async () => {
    const created = defineHarnessAgent({ model })
    expect(created.id).toBe('agent')
    expect(Object.isFrozen(created.config)).toBe(true)
    const session = created.session('s1')
    expect(session.id).toBe('s1')
    expect(session.running).toBe(false)
    expect(created.session('s1')).toBe(session)
    await created.close()
  })

  test('two agents never share warning dedupe or ids state', () => {
    const one = getAgentInternals(defineHarnessAgent({ model }))
    const two = getAgentInternals(defineHarnessAgent({ model }))
    expect(one.emitWarning).not.toBe(two.emitWarning)
    const first = one.generateId()
    expect(one.generateId() > first).toBe(true)
  })

  test('custom generateId is used', () => {
    let n = 0
    const created = defineHarnessAgent({ model, generateId: () => `id-${++n}` })
    expect(getAgentInternals(created).generateId()).toBe('id-1')
  })

  test('mcp sources join the root tools; mcp must contain tool sources', () => {
    const mcp = defineToolSource({ id: 'mcp:github', list: () => ({}) })
    const created = defineHarnessAgent({ model, mcp: [mcp] })
    expect(getAgentInternals(created).statics.toolSources.map((s) => s.source.id)).toEqual([
      'mcp:github',
    ])
    expectBootError(agent({ mcp: [{} as never] }), 'EH_CONFIG_INVALID', ['mcp'])
  })

  test('accepts zod, Standard Schema and jsonSchema() as callOptions', () => {
    expect(() =>
      defineHarnessAgent({ model, callOptions: z.object({ a: z.string() }) }),
    ).not.toThrow()
    expect(() =>
      defineHarnessAgent({ model, callOptions: jsonSchema({ type: 'object' }) }),
    ).not.toThrow()
  })
})

describe('defineHarnessAgent: boot errors (spec 01 §7)', () => {
  test('EH_CONFIG_INVALID: invalid, reserved and duplicate plugin names', () => {
    expect(() => definePlugin({ name: 'Bad Name' })).toThrow()
    expectBootError(() => definePlugin({ name: 'app' }), 'EH_CONFIG_INVALID', ["'app'"])
    expectBootError(() => definePlugin({ name: 'eh' }), 'EH_CONFIG_INVALID', ["'eh'"])
    expectBootError(() => definePlugin({ name: 'Bad' }), 'EH_CONFIG_INVALID', ["'Bad'"])
    const fake = { name: 'app', '~def': { name: 'app' } } as never
    expectBootError(agent({ plugins: [fake] }), 'EH_CONFIG_INVALID', ["'app'"])
    const p = definePlugin({ name: 'dup' })
    expectBootError(agent({ plugins: [p, definePlugin({ name: 'dup' })] }), 'EH_CONFIG_INVALID', [
      "'dup'",
      'plugins[0]',
      'plugins[1]',
    ])
  })

  test('EH_DUPLICATE_TOOL: two static tools with the same name', () => {
    const p = definePlugin({ name: 'fs', setup: () => ({ tools: { echo } }) })
    expectBootError(agent({ tools: { echo }, plugins: [p] }), 'EH_DUPLICATE_TOOL', [
      "'echo'",
      'the app',
      "plugin 'fs'",
    ])
    const q = definePlugin({ name: 'other', setup: () => ({ tools: { echo } }) })
    expectBootError(agent({ plugins: [p, q] }), 'EH_DUPLICATE_TOOL', [
      "plugin 'fs'",
      "plugin 'other'",
    ])
  })

  test('EH_DUPLICATE_TOOL: reserved tool names', () => {
    for (const name of ['tool_search', 'load_skill', 'read_skill_file', 'search_skills']) {
      expectBootError(agent({ tools: { [name]: echo } }), 'EH_DUPLICATE_TOOL', [name, 'the app'])
    }
    const p = definePlugin({ name: 'sk', setup: () => ({ tools: { load_skill: echo } }) })
    expectBootError(agent({ plugins: [p] }), 'EH_DUPLICATE_TOOL', ["plugin 'sk'"])
  })

  test('EH_DUPLICATE_SKILL: two static skills with the same name', () => {
    const p = definePlugin({ name: 'fs', setup: () => ({ skills: [skill('pine')] }) })
    expectBootError(agent({ skills: [skill('pine')], plugins: [p] }), 'EH_DUPLICATE_SKILL', [
      "'pine'",
      'the app',
      "plugin 'fs'",
    ])
  })

  test('EH_DUPLICATE_DATA_PART: data part / kind collision', () => {
    expectBootError(
      agent({ dataParts: { note: part }, messageKinds: { note: kind } }),
      'EH_DUPLICATE_DATA_PART',
      ['data-note', 'app data part', 'app message kind'],
    )
    const p = definePlugin({
      name: 'fs',
      dataParts: { change: part },
      messageKinds: { change: kind },
    })
    expectBootError(agent({ plugins: [p] }), 'EH_DUPLICATE_DATA_PART', [
      'data-fs.change',
      "data part of plugin 'fs'",
      "message kind of plugin 'fs'",
    ])
  })

  test('EH_SERVICE_CONFLICT: two providers for one service', () => {
    const a = definePlugin({ name: 'a', provides: ['fs'] })
    const b = definePlugin({ name: 'b', provides: ['fs'] })
    expectBootError(agent({ plugins: [a, b] }), 'EH_SERVICE_CONFLICT', ["'fs'", "'a'", "'b'"])
  })

  test('EH_SERVICE_MISSING: required service without provider', () => {
    const b = definePlugin({ name: 'b', requires: ['fs'] })
    expectBootError(agent({ plugins: [b] }), 'EH_SERVICE_MISSING', ["'fs'", "'b'"])
  })

  test('EH_PLUGIN_ORDER: requirer ordered before provider', () => {
    const provider = definePlugin({ name: 'files', provides: ['fs'] })
    const requirer = definePlugin({ name: 'skills', requires: ['fs'] })
    expect(() => defineHarnessAgent({ model, plugins: [provider, requirer] })).not.toThrow()
    expectBootError(agent({ plugins: [requirer, provider] }), 'EH_PLUGIN_ORDER', [
      "'fs'",
      "'files'",
      "'skills'",
    ])
  })

  test('EH_CONFIG_INVALID: callOptions is not a schema', () => {
    expectBootError(agent({ callOptions: { a: 1 } as never }), 'EH_CONFIG_INVALID', ['callOptions'])
  })

  test('EH_CONFIG_INVALID: settings.timeout.totalMs', () => {
    expectBootError(
      agent({ settings: { timeout: { totalMs: 1000 } as never } }),
      'EH_CONFIG_INVALID',
      ['totalMs'],
    )
    expect(() => defineHarnessAgent({ model, settings: { timeout: { stepMs: 1 } } })).not.toThrow()
  })

  test('EH_CONFIG_INVALID: app data part / kind names with a dot or eh prefix', () => {
    expectBootError(agent({ dataParts: { 'a.b': part } }), 'EH_CONFIG_INVALID', [
      'the app',
      "'a.b'",
    ])
    expectBootError(agent({ dataParts: { ehlo: part } }), 'EH_CONFIG_INVALID', [
      'the app',
      "'ehlo'",
    ])
    expectBootError(agent({ messageKinds: { 'x.y': kind } }), 'EH_CONFIG_INVALID', [
      'the app',
      "'x.y'",
    ])
    expectBootError(agent({ messageKinds: { ehx: kind } }), 'EH_CONFIG_INVALID', [
      'the app',
      "'ehx'",
    ])
    expectBootError(
      () => definePlugin({ name: 'fs', dataParts: { 'a.b': part } }),
      'EH_CONFIG_INVALID',
      ["plugin 'fs'", "'a.b'"],
    )
  })

  test('EH_CONFIG_INVALID: other invalid options', () => {
    expectBootError(() => defineHarnessAgent({} as never), 'EH_CONFIG_INVALID', ['model'])
    expectBootError(agent({ contextWindow: -1 }), 'EH_CONFIG_INVALID', ['contextWindow'])
    expectBootError(agent({ dataParts: { note: {} as never } }), 'EH_CONFIG_INVALID', ['schema'])
    expectBootError(agent({ tools: { 'bad name': echo } }), 'EH_CONFIG_INVALID', ['bad name'])
    expectBootError(agent({ instructions: [42 as never] }), 'EH_CONFIG_INVALID', ['instruction'])
    expectBootError(agent({ skills: [{ nope: true } as never] }), 'EH_CONFIG_INVALID', ['skill'])
    const hooky = definePlugin({
      name: 'hooky',
      setup: () => ({ hooks: { 'turn.strat': () => {} } as never }),
    })
    expectBootError(agent({ plugins: [hooky] }), 'EH_CONFIG_INVALID', [
      "plugin 'hooky'",
      'turn.strat',
    ])
  })

  test('EH_CONFIG_INVALID: async or throwing setup', () => {
    const asyncSetup = definePlugin({ name: 'slow', setup: (async () => ({})) as never })
    expectBootError(agent({ plugins: [asyncSetup] }), 'EH_CONFIG_INVALID', [
      "plugin 'slow'",
      'synchronous',
    ])
    const throwing = definePlugin({
      name: 'boom',
      setup: () => {
        throw new Error('kaput')
      },
    })
    expectBootError(agent({ plugins: [throwing] }), 'EH_CONFIG_INVALID', ["plugin 'boom'", 'kaput'])
  })
})
