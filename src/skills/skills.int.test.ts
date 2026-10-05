import { describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod/v4'
import { defineHarnessAgent } from '../agent/define-agent.ts'
import type { HarnessAgentConfig } from '../agent/types.ts'
import { type HarnessWarning, isHarnessError } from '../errors.ts'
import type { HarnessUIMessage } from '../messages/types.ts'
import { definePlugin } from '../plugin/define-plugin.ts'
import { defineToolSource } from '../registry/tool-source.ts'
import type { Skill, SkillMeta } from '../registry/types.ts'
import { spyMessages, spyState } from '../session/int-kit.ts'
import {
  type ScriptedCallOptions,
  type ScriptedStepInput,
  scriptedModel,
} from '../testing/scripted-model.ts'
import { defineSkill, defineSkillSource } from './define.ts'
import { SKILLS_INDEX_INTRO, SKILLS_SEARCH_HINT } from './registry.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

function setup(steps: ScriptedStepInput[], config: Partial<HarnessAgentConfig> = {}) {
  const model = scriptedModel(steps)
  const warnings: HarnessWarning[] = []
  const agent = defineHarnessAgent({
    model,
    contextWindow: 100_000,
    storage: { messages: spyMessages(), state: spyState() },
    logger: silent,
    onWarning: (w) => warnings.push(w),
    ...config,
  })
  return { agent, model, warnings }
}

async function expectGolden(name: string, value: unknown): Promise<void> {
  const file = Bun.file(new URL(`./__golden__/${name}.json`, import.meta.url))
  const actual = JSON.parse(JSON.stringify(value))
  if (process.env.UPDATE_GOLDEN === '1') {
    await Bun.write(file, `${JSON.stringify(actual, null, 2)}\n`)
    return
  }
  if (!(await file.exists())) throw new Error(`missing golden ${name}.json (UPDATE_GOLDEN=1)`)
  expect(actual).toEqual(await file.json())
}

/** Tool outputs of an assistant message, in part order: `[toolName, output | errorText]`. */
function toolOutputs(message: HarnessUIMessage | undefined): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = []
  for (const part of message?.parts ?? []) {
    if (!part.type.startsWith('tool-')) continue
    const p = part as { type: string; output?: unknown; errorText?: string }
    out.push([p.type.slice(5), p.output ?? p.errorText])
  }
  return out
}

function systemOf(call: ScriptedCallOptions | undefined): string[] {
  return (call?.prompt ?? [])
    .filter((m) => m.role === 'system')
    .map((m) => (m as { content: string }).content)
}

function toolNames(call: ScriptedCallOptions | undefined): string[] {
  return (call?.tools ?? []).map((t) => t.name)
}

const PINE: Skill = {
  name: 'pine-v6',
  description: 'Pine Script v6 syntax and pitfalls. Use when writing Pine.',
  content: '# Pine v6\n\nRead reference.md before answering.\n',
  meta: { license: 'MIT', tags: ['trading', 'pine'] },
  files: [
    { path: 'reference.md', content: '# Reference\n\nplot(close) ✓\n' },
    { path: 'scripts/check.py', content: 'print("ok")\n' },
  ],
}

/** A dynamic source serving the same content as a static skill, over "rows". */
function rowSource(rows: Skill[], id = 'db:skills', refresh: 'session' | 'turn' = 'session') {
  const encoder = new TextEncoder()
  const reads: string[] = []
  const source = defineSkillSource({
    id,
    refresh,
    list: (): SkillMeta[] =>
      rows.map((r) => ({
        name: r.name,
        description: r.description,
        ...(r.meta ? { meta: r.meta } : {}),
      })),
    load: (name) => {
      const row = rows.find((r) => r.name === name)
      if (row === undefined) return null
      return {
        name: row.name,
        description: row.description,
        ...(row.meta ? { meta: row.meta } : {}),
        content: row.content,
        // reverse order on purpose: the output is sorted by path
        manifest: [...(row.files ?? [])]
          .reverse()
          .map((f) => ({ path: f.path, size: encoder.encode(f.content).byteLength })),
      }
    },
    readFile: (name, path) => {
      reads.push(`${name}:${path}`)
      const file = rows.find((r) => r.name === name)?.files?.find((f) => f.path === path)
      return file === undefined ? null : { type: 'text', text: file.content }
    },
  })
  return Object.assign(source, { reads })
}

const skillCalls: ScriptedStepInput[] = [
  {
    toolCalls: [
      { toolName: 'load_skill', input: { name: 'pine-v6' } },
      { toolName: 'read_skill_file', input: { name: 'pine-v6', path: 'reference.md' } },
      { toolName: 'read_skill_file', input: { name: 'pine-v6', path: './scripts/check.py' } },
      { toolName: 'read_skill_file', input: { name: 'pine-v6', path: '../../etc/passwd' } },
      { toolName: 'read_skill_file', input: { name: 'pine-v6', path: 'SKILL.md' } },
      { toolName: 'read_skill_file', input: { name: 'pine-v6', path: 'missing.md' } },
      { toolName: 'load_skill', input: { name: 'nope' } },
    ],
  },
  { text: 'done' },
]

describe('skill versions (spec 07 §3, §4.3)', () => {
  test('load_skill shows the version (golden); the skills index does not', async () => {
    const unlimited = { skillsIndexLimit: Number.POSITIVE_INFINITY }
    const calls: ScriptedStepInput[] = [
      { toolCalls: [{ toolName: 'load_skill', input: { name: 'pine-v6' } }] },
      { text: 'done' },
    ]
    const versioned = setup(calls, {
      ...unlimited,
      skills: [defineSkill({ ...PINE, version: '1.0' })],
    })
    const result = await versioned.agent.session('s').send('go').result
    const outputs = toolOutputs(result.messages.find((m) => m.id === result.messageId))
    await expectGolden('skill-version-output', outputs)
    expect(JSON.stringify(outputs)).toContain('version: \\"1.0\\"')
    const plain = setup(calls, { ...unlimited, skills: [defineSkill(PINE)] })
    await plain.agent.session('s').send('go').result
    expect(systemOf(versioned.model.calls[0])).toEqual(systemOf(plain.model.calls[0]))
  })
})

describe('static and dynamic skills are indistinguishable for the model (golden)', () => {
  test('same tool outputs for the same content', async () => {
    // an unlimited index keeps search_skills away, so both tool lists are comparable
    const unlimited = { skillsIndexLimit: Number.POSITIVE_INFINITY }
    const staticRun = setup(skillCalls, { ...unlimited, skills: [defineSkill(PINE)] })
    const staticResult = await staticRun.agent.session('s').send('go').result
    const dynamicSource = rowSource([PINE])
    const dynamicRun = setup(skillCalls, { ...unlimited, skills: [dynamicSource] })
    const dynamicResult = await dynamicRun.agent.session('s').send('go').result
    expect(staticResult.stop).toBe('complete')
    expect(dynamicResult.stop).toBe('complete')

    const fromStatic = toolOutputs(
      staticResult.messages.find((m) => m.id === staticResult.messageId),
    )
    const fromDynamic = toolOutputs(
      dynamicResult.messages.find((m) => m.id === dynamicResult.messageId),
    )
    expect(fromStatic).toEqual(fromDynamic)
    await expectGolden('skill-tool-outputs', fromStatic)
    // invalid paths never reached the source
    expect(dynamicSource.reads).toEqual([
      'pine-v6:reference.md',
      'pine-v6:scripts/check.py',
      'pine-v6:missing.md',
    ])
    // same tool definitions; the index sits in block 1 (static) vs block 2 (dynamic)
    expect(staticRun.model.calls[0]?.tools).toEqual(dynamicRun.model.calls[0]?.tools)
    const line = `- pine-v6: ${PINE.description}`
    expect(systemOf(staticRun.model.calls[0])).toEqual([`# Skills\n${SKILLS_INDEX_INTRO}\n${line}`])
    expect(systemOf(dynamicRun.model.calls[0])).toEqual([
      `# Skills\n${SKILLS_INDEX_INTRO}\n${line}`,
    ])
  })
})

describe('skill tool input validation', () => {
  test('invalid input becomes an AI SDK tool error the model can read', async () => {
    const { agent, model } = setup(
      [{ toolCalls: [{ toolName: 'load_skill', input: { name: 42 } }] }, { text: 'done' }],
      { skills: [defineSkill(PINE)] },
    )
    const result = await agent.session('s').send('go').result
    expect(result.stop).toBe('complete')
    const [entry] = toolOutputs(result.messages.find((m) => m.id === result.messageId))
    expect(entry?.[0]).toBe('load_skill')
    expect(String(entry?.[1])).toStartWith(
      'AI_InvalidToolInputError: Invalid input for tool load_skill:',
    )
    expect(JSON.stringify(model.prompts[1])).toContain('Invalid input for tool load_skill:')
  })
})

describe('prompt layout and tool order', () => {
  test('index appended to static instructions; skill tools after static tools, before source tools', async () => {
    const source = defineToolSource({
      id: 'src',
      list: () => ({ dyn_tool: tool({ inputSchema: z.object({}), execute: async () => 'd' }) }),
    })
    const { agent, model } = setup([{ text: 'ok' }], {
      instructions: ['You are careful.', () => 'Session text.'],
      tools: [
        { static_tool: tool({ inputSchema: z.object({}), execute: async () => 's' }) },
        source,
      ],
      skills: [
        defineSkill({ name: 'zeta', description: 'Z skill.', content: 'z' }),
        defineSkill({ name: 'alpha', description: 'A skill.', content: 'a' }),
        rowSource([{ name: 'beta', description: 'B skill.', content: 'b' }]),
      ],
    })
    await agent.session('s').send('hi').result
    expect(systemOf(model.calls[0])).toEqual([
      `You are careful.\n\n# Skills\n${SKILLS_INDEX_INTRO}\n- alpha: A skill.\n- zeta: Z skill.`,
      'Session text.\n\n# More skills\n- beta: B skill.',
    ])
    expect(toolNames(model.calls[0])).toEqual([
      'static_tool',
      'load_skill',
      'read_skill_file',
      'search_skills',
      'dyn_tool',
    ])
  })

  test('no skill sources: no index, no skill tools', async () => {
    const { agent, model } = setup([{ text: 'ok' }], { instructions: 'Hi.' })
    await agent.session('s').send('hi').result
    expect(systemOf(model.calls[0])).toEqual(['Hi.'])
    expect(toolNames(model.calls[0])).toEqual([])
  })

  test('the skill tool list is stable across turns (empty, failing, growing past the limit)', async () => {
    let rows: Skill[] | 'fail' = []
    const live = defineSkillSource({
      id: 'db:live',
      refresh: 'turn',
      list: () => {
        if (rows === 'fail') throw new Error('db down')
        return rows.map((r) => ({ name: r.name, description: r.description }))
      },
      load: (name) => {
        const row = rows === 'fail' ? undefined : rows.find((r) => r.name === name)
        return row === undefined ? null : { ...row, manifest: [] }
      },
      readFile: () => null,
    })
    const { agent, model } = setup(
      [
        { toolCalls: [{ toolName: 'load_skill', input: { name: 'a' } }] },
        { text: '1' },
        { text: '2' },
        { text: '3' },
        { text: '4' },
      ],
      { skills: [live], skillsIndexLimit: 2 },
    )
    const session = agent.session('s')
    const first = await session.send('empty').result
    expect(toolOutputs(first.messages.find((m) => m.id === first.messageId))).toEqual([
      ['load_skill', 'ERROR: skill "a" not found'],
    ])
    rows = 'fail'
    await session.send('failing').result
    rows = [{ name: 'a', description: 'A.', content: 'a' }]
    await session.send('one').result
    rows = ['a', 'b', 'c'].map((n) => ({ name: n, description: `${n}.`, content: n }))
    await session.send('three').result
    const lists = model.calls.map((c) => JSON.stringify(c.tools))
    expect(model.calls).toHaveLength(5)
    expect(new Set(lists).size).toBe(1)
    expect(toolNames(model.calls[0])).toEqual(['load_skill', 'read_skill_file', 'search_skills'])
    expect(systemOf(model.calls[0])).toEqual([])
    expect(systemOf(model.calls[4])).toEqual([`# Skills\n${SKILLS_SEARCH_HINT}`])
  })

  test('search mode above skillsIndexLimit: hint + search_skills', async () => {
    const { agent, model } = setup(
      [{ toolCalls: [{ toolName: 'search_skills', input: { query: 'pine' } }] }, { text: 'ok' }],
      {
        skillsIndexLimit: 1,
        skills: [
          defineSkill(PINE),
          defineSkill({ name: 'python-lint', description: 'Lint Python.', content: 'p' }),
        ],
      },
    )
    const result = await agent.session('s').send('hi').result
    expect(systemOf(model.calls[0])).toEqual([`# Skills\n${SKILLS_SEARCH_HINT}`])
    expect(toolNames(model.calls[0])).toEqual(['load_skill', 'read_skill_file', 'search_skills'])
    expect(toolOutputs(result.messages.find((m) => m.id === result.messageId))).toEqual([
      ['search_skills', `- pine-v6: ${PINE.description}`],
    ])
  })
})

describe('scenario 8: static vs dynamic skills (static part)', () => {
  test('static/static duplicates fail at boot with EH_DUPLICATE_SKILL', () => {
    const dup = definePlugin({
      name: 'dup',
      setup: () => ({ skills: [defineSkill({ name: 'pine-v6', description: 'x', content: 'x' })] }),
    })
    try {
      setup([], { skills: [defineSkill(PINE)], plugins: [dup] })
      throw new Error('expected EH_DUPLICATE_SKILL')
    } catch (error) {
      expect(isHarnessError(error, 'EH_DUPLICATE_SKILL')).toBe(true)
      expect((error as Error).message).toContain("plugin 'dup'")
    }
  })

  test('invalid static skills fail at boot with EH_CONFIG_INVALID naming the owner', () => {
    const bad = definePlugin({
      name: 'bad',
      setup: () => ({ skills: [{ name: 'Bad Name', description: 'x', content: 'x' }] }),
    })
    try {
      setup([], { plugins: [bad] })
      throw new Error('expected EH_CONFIG_INVALID')
    } catch (error) {
      expect(isHarnessError(error, 'EH_CONFIG_INVALID')).toBe(true)
      expect((error as Error).message).toContain("plugin 'bad'")
    }
  })

  test('a dynamic duplicate is shadowed by the static skill (W_SHADOWED)', async () => {
    const dyn = rowSource([{ ...PINE, content: 'dynamic body' }])
    const { agent, warnings } = setup(
      [{ toolCalls: [{ toolName: 'load_skill', input: { name: 'pine-v6' } }] }, { text: 'ok' }],
      { skills: [defineSkill(PINE), dyn] },
    )
    const result = await agent.session('s').send('go').result
    const [[, output]] = toolOutputs(result.messages.find((m) => m.id === result.messageId)) as [
      [string, string],
    ]
    expect(output).toContain('Read reference.md before answering.')
    expect(output).not.toContain('dynamic body')
    expect(warnings.filter((w) => w.code === 'W_SHADOWED').map((w) => w.details?.source)).toEqual([
      'db:skills',
    ])
  })

  test("refresh 'turn' picks up a new skill at the next turn, not mid-turn", async () => {
    const rows: Skill[] = [{ name: 'first', description: 'First skill.', content: 'one' }]
    const source = rowSource(rows, 'db:live', 'turn')
    const { agent, model } = setup(
      [
        // turn 1, step 0: a new skill appears in the source during the turn
        () => {
          rows.push({ name: 'second', description: 'Second skill.', content: 'two' })
          return { toolCalls: [{ toolName: 'load_skill', input: { name: 'second' } }] }
        },
        { text: 'turn 1 done' },
        // turn 2
        { toolCalls: [{ toolName: 'load_skill', input: { name: 'second' } }] },
        { text: 'turn 2 done' },
      ],
      { skills: [source] },
    )
    const session = agent.session('s')
    const first = await session.send('one').result
    expect(toolOutputs(first.messages.find((m) => m.id === first.messageId))).toEqual([
      ['load_skill', 'ERROR: skill "second" not found'],
    ])
    // the index is locked for the turn: step 1 still shows only the first skill
    expect(systemOf(model.calls[1])).toEqual([
      `# Skills\n${SKILLS_INDEX_INTRO}\n- first: First skill.`,
    ])
    const second = await session.send('two').result
    expect(systemOf(model.calls[2])).toEqual([
      `# Skills\n${SKILLS_INDEX_INTRO}\n- first: First skill.\n- second: Second skill.`,
    ])
    expect(toolOutputs(second.messages.find((m) => m.id === second.messageId))).toEqual([
      ['load_skill', '---\nname: second\ndescription: Second skill.\n---\ntwo'],
    ])
  })

  test("refresh 'session' keeps the first listing for the session", async () => {
    const rows: Skill[] = [{ name: 'first', description: 'First skill.', content: 'one' }]
    const { agent, model } = setup([{ text: 'a' }, { text: 'b' }], {
      skills: [rowSource(rows)],
    })
    const session = agent.session('s')
    await session.send('one').result
    rows.push({ name: 'second', description: 'Second skill.', content: 'two' })
    await session.send('two').result
    expect(systemOf(model.calls[1])).toEqual(systemOf(model.calls[0]))
  })

  test('session-phase skills and sources join the registry in plugin order', async () => {
    const plugin = definePlugin({
      name: 'tenant',
      session: () => ({
        skills: [
          defineSkill({ name: 'tenant-static', description: 'Tenant static.', content: 't' }),
          rowSource([{ name: 'tenant-dynamic', description: 'Tenant dynamic.', content: 'd' }]),
        ],
      }),
    })
    const { agent, model } = setup([{ text: 'ok' }], {
      skills: [defineSkill({ name: 'root', description: 'Root.', content: 'r' })],
      plugins: [plugin],
    })
    await agent.session('s').send('hi').result
    expect(systemOf(model.calls[0])).toEqual([
      `# Skills\n${SKILLS_INDEX_INTRO}\n- root: Root.\n- tenant-static: Tenant static.`,
      '# More skills\n- tenant-dynamic: Tenant dynamic.',
    ])
  })
})

describe('skill.load hooks through a plugin (spec 07 §7)', () => {
  test('notes are appended; the hook sees the source id and location', async () => {
    const seen: unknown[] = []
    const located = Object.assign(rowSource([PINE], 'fs:/skills'), {
      locate: (name: string) => ({ service: 'fs', root: `/skills/${name}` }),
    })
    const sandbox = definePlugin({
      name: 'sandbox',
      setup: () => ({
        hooks: {
          'skill.load': (ctx, e) => {
            seen.push({ plugin: ctx.plugin.name, source: e.source, location: e.location })
            return {
              notes: [`Executable copy: ${e.location?.root} (sandbox). Run scripts from there.`],
            }
          },
        },
      }),
    })
    const { agent } = setup(
      [{ toolCalls: [{ toolName: 'load_skill', input: { name: 'pine-v6' } }] }, { text: 'ok' }],
      { skills: [located], plugins: [sandbox] },
    )
    const result = await agent.session('s').send('go').result
    const [[, output]] = toolOutputs(result.messages.find((m) => m.id === result.messageId)) as [
      [string, string],
    ]
    expect(
      output.endsWith('Executable copy: /skills/pine-v6 (sandbox). Run scripts from there.'),
    ).toBe(true)
    expect(seen).toEqual([
      {
        plugin: 'sandbox',
        source: 'fs:/skills',
        location: { service: 'fs', root: '/skills/pine-v6' },
      },
    ])
  })
})

describe('ctx.warn (sources report their own problems)', () => {
  test('reaches onWarning with the owner and the turn stream as data-eh.warning', async () => {
    const plugin = definePlugin({
      name: 'fsx',
      setup: () => ({
        skills: [
          defineSkillSource({
            id: 'fs:/skills',
            list: (ctx) => {
              ctx.warn({
                code: 'W_INVALID_SKILL',
                message: 'Skipped /skills/bad/SKILL.md: invalid frontmatter',
                details: { source: 'fs:/skills' },
              })
              return []
            },
            load: () => null,
            readFile: () => null,
          }),
        ],
      }),
    })
    const { agent, warnings } = setup([{ text: 'ok' }], { plugins: [plugin] })
    const run = agent.session('s').send('hi')
    const chunks: Array<{ type: string; data?: unknown }> = []
    for await (const chunk of run.stream as ReadableStream<{ type: string; data?: unknown }>) {
      chunks.push(chunk)
    }
    await run.result
    expect(warnings).toEqual([
      {
        code: 'W_INVALID_SKILL',
        message: 'Skipped /skills/bad/SKILL.md: invalid frontmatter',
        details: { plugin: 'fsx', source: 'fs:/skills' },
      },
    ])
    expect(chunks.filter((c) => c.type === 'data-eh.warning').map((c) => c.data)).toEqual([
      { code: 'W_INVALID_SKILL', message: 'Skipped /skills/bad/SKILL.md: invalid frontmatter' },
    ])
  })

  test('strict mode escalates misuse codes', async () => {
    let caught: unknown
    const plugin = definePlugin({
      name: 'p',
      session: (ctx) => {
        try {
          ctx.warn({ code: 'W_WRITE_OUTSIDE_TURN', message: 'misuse' })
        } catch (error) {
          caught = error
        }
      },
    })
    const { agent } = setup([{ text: 'ok' }], { plugins: [plugin], strict: true })
    await agent.session('s').send('hi').result
    expect(isHarnessError(caught, 'EH_CONFIG_INVALID')).toBe(true)
  })
})
