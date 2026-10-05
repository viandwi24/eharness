/**
 * Integration tests of the filesystem plugin with scripted turns: testing.md scenario 9 (file
 * tools), the fs half of scenario 8 (skills autoload), scenario 10 (`ctx.services.fs`) and the
 * `toolOutputs` service.
 */
import { describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod/v4'
import {
  defineHarnessAgent,
  definePlugin,
  defineSkill,
  type HarnessAgentConfig,
  type HarnessWarning,
  isHarnessError,
  type StateAdapter,
} from '../index.ts'
import { memoryMessages, memoryState } from '../storage/memory.ts'
import {
  type ScriptedStep,
  type ScriptedStepInput,
  scriptedModel,
} from '../testing/scripted-model.ts'
import { classifyToolResult } from './classify.ts'
import { memoryFs } from './memory.ts'
import { filesystem } from './plugin.ts'
import type { FileSystem, FilesystemOptions } from './types.ts'
import { contentVersion } from './version.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

function setup(
  steps: ScriptedStepInput[],
  fsOptions: FilesystemOptions,
  config: Partial<HarnessAgentConfig> = {},
  state: StateAdapter = memoryState(),
) {
  const model = scriptedModel(steps)
  const warnings: HarnessWarning[] = []
  const messages = memoryMessages()
  const agent = defineHarnessAgent({
    model,
    contextWindow: 100_000,
    storage: { messages, state },
    logger: silent,
    onWarning: (w) => warnings.push(w),
    ...config,
    plugins: [filesystem(fsOptions), ...(config.plugins ?? [])],
  })
  return { agent, model, warnings, messages, state }
}

/** Tool outputs of an assistant message, in part order: `[toolName, output | errorText]`. */
function toolOutputs(
  message: { parts: Array<{ type: string }> } | undefined,
): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = []
  for (const part of message?.parts ?? []) {
    if (!part.type.startsWith('tool-')) continue
    const p = part as { type: string; output?: unknown; errorText?: string }
    out.push([p.type.slice(5), p.output ?? p.errorText])
  }
  return out
}

function changeParts(message: { parts: Array<{ type: string }> } | undefined): unknown[] {
  return (message?.parts ?? [])
    .filter((part) => part.type === 'data-filesystem.change')
    .map((part) => {
      const p = part as unknown as { id?: string; data: unknown }
      return { id: p.id, data: p.data }
    })
}

type Result = Awaited<
  ReturnType<ReturnType<ReturnType<typeof setup>['agent']['session']>['send']>['result']
>
const assistant = (result: Result) => result.messages.find((m) => m.id === result.messageId)
const outputs = (result: Result) => toolOutputs(assistant(result)).map(([, output]) => output)

const call = (toolName: string, input: unknown) => ({ toolName, input })
const steps = (...calls: Array<ReturnType<typeof call>>): ScriptedStepInput[] => [
  ...calls.map((c) => ({ toolCalls: [c] })),
  { text: 'done' },
]

describe('file tools: read-before-edit, STALE, CONFLICT (scenario 9)', () => {
  test('edit requires a prior read; read shows numbered lines; edit writes and emits a change part', async () => {
    const fs = memoryFs({ '/src/main.pine': 'plot(close)\nplot(open)\n' })
    const { agent } = setup(
      steps(
        call('edit_file', { path: '/src/main.pine', old_string: 'open', new_string: 'high' }),
        call('read_file', { path: 'src/main.pine' }),
        call('edit_file', { path: '/src/main.pine', old_string: 'open', new_string: 'high' }),
      ),
      { fs },
    )
    const result = await agent.session('s').send('go').result
    expect(result.stop).toBe('complete')
    expect(outputs(result)).toEqual([
      'ERROR: read /src/main.pine with read_file before editing it.',
      '     1\tplot(close)\n     2\tplot(open)',
      'Edited /src/main.pine (1 replacement).',
    ])
    expect((await fs.read('/src/main.pine'))?.content).toBe('plot(close)\nplot(high)\n')
    expect(changeParts(assistant(result))).toEqual([
      {
        id: '/src/main.pine',
        data: {
          path: '/src/main.pine',
          action: 'edit',
          version: await contentVersion('plot(close)\nplot(high)\n'),
          bytes: 23,
        },
      },
    ])
  })

  test('STALE: an external write between read and edit returns the new content; the retry succeeds', async () => {
    const inner = memoryFs({ '/a.md': 'alpha\nbeta\n' })
    let external: string | undefined
    // someone else edits the file right before the tool looks at it
    const fs: FileSystem = {
      ...inner,
      async read(path) {
        if (external !== undefined) {
          await inner.write(path, external)
          external = undefined
        }
        return inner.read(path)
      },
    }
    const { agent } = setup(
      [
        { toolCalls: [call('read_file', { path: '/a.md' })] },
        () => {
          external = 'alpha\nbeta\ngamma\n'
          return {
            toolCalls: [call('edit_file', { path: '/a.md', old_string: 'beta', new_string: 'B' })],
          }
        },
        { toolCalls: [call('edit_file', { path: '/a.md', old_string: 'beta', new_string: 'B' })] },
        { text: 'done' },
      ],
      { fs },
    )
    const result = await agent.session('s').send('go').result
    const [, stale, retry] = outputs(result) as [string, string, string]
    expect(classifyToolResult(stale)).toBe('stale')
    expect(stale).toBe(
      'STALE: /a.md changed since you last read it. Its current content is below; apply your change to this version.\n\n     1\talpha\n     2\tbeta\n     3\tgamma',
    )
    expect(retry).toBe('Edited /a.md (1 replacement).')
    expect((await fs.read('/a.md'))?.content).toBe('alpha\nB\ngamma\n')
  })

  test('CONFLICT: a concurrent write between the check and the write is detected via ifVersion', async () => {
    const inner = memoryFs({ '/a.md': 'one' })
    let race = false
    const fs: FileSystem = {
      ...inner,
      async read(path) {
        const entry = await inner.read(path)
        if (race) {
          race = false
          await inner.write(path, 'someone else') // lands after our read, before our write
        }
        return entry
      },
    }
    const { agent } = setup(
      [
        { toolCalls: [call('read_file', { path: '/a.md' })] },
        () => {
          race = true
          return { toolCalls: [call('write_file', { path: '/a.md', content: 'mine' })] }
        },
        { toolCalls: [call('write_file', { path: '/a.md', content: 'mine' })] },
        { text: 'done' },
      ],
      { fs },
    )
    const result = await agent.session('s').send('go').result
    const [, conflict, next] = outputs(result) as [string, string, string]
    expect(conflict).toBe(
      'CONFLICT: /a.md was changed by someone else at the same time; read it again and retry.',
    )
    expect(classifyToolResult(conflict)).toBe('conflict')
    // the next attempt sees the other writer's content first
    expect(next.startsWith('STALE: /a.md changed since you last read it.')).toBe(true)
    expect(next).toContain('someone else')
    expect((await inner.read('/a.md'))?.content).toBe('someone else')
  })

  test('write_file: create, overwrite only after reading, change parts for create and write', async () => {
    const fs = memoryFs({ '/old.md': 'old' })
    const { agent } = setup(
      steps(
        call('write_file', { path: '/new.md', content: 'ø new' }),
        call('write_file', { path: '/new.md', content: 'again' }),
        call('write_file', { path: '/old.md', content: 'x' }),
        call('write_file', { path: '/', content: 'x' }),
        call('write_file', { path: '/../x.md', content: 'x' }),
      ),
      { fs },
    )
    const result = await agent.session('s').send('go').result
    expect(outputs(result)).toEqual([
      'Created /new.md (6 bytes).',
      'Wrote /new.md (5 bytes).',
      'ERROR: read /old.md with read_file before overwriting it.',
      'ERROR: invalid path: the path does not name a file',
      'ERROR: invalid path: the path escapes the root',
    ])
    // same id → the stored message keeps the latest change part of the path
    expect(changeParts(assistant(result))).toEqual([
      {
        id: '/new.md',
        data: {
          path: '/new.md',
          action: 'write',
          version: await contentVersion('again'),
          bytes: 5,
        },
      },
    ])
  })

  test('delete_file: policy, read-before-delete, change part with version null', async () => {
    const fs = memoryFs({ '/a.md': 'a', '/keep.md': 'k', '/vendor/lib.md': 'v' })
    const { agent } = setup(
      steps(
        call('delete_file', { path: '/a.md' }),
        call('read_file', { path: '/a.md' }),
        call('delete_file', { path: '/a.md' }),
        call('delete_file', { path: '/a.md' }),
        call('delete_file', { path: '/keep.md' }),
        call('delete_file', { path: '/vendor/lib.md' }),
      ),
      { fs, isUndeletable: (path) => path === '/keep.md', readonlyPrefixes: ['/vendor'] },
    )
    const result = await agent.session('s').send('go').result
    expect(outputs(result)).toEqual([
      'ERROR: read /a.md with read_file before deleting it.',
      '     1\ta',
      'Deleted /a.md.',
      'ERROR: file not found: /a.md',
      'REJECTED: /keep.md cannot be deleted.',
      'REJECTED: /vendor/lib.md is read-only.',
    ])
    expect(changeParts(assistant(result))).toEqual([
      { id: '/a.md', data: { path: '/a.md', action: 'delete', version: null } },
    ])
    expect(await fs.read('/keep.md')).not.toBeNull()
  })

  test('policy: allowed extensions and read-only prefixes', async () => {
    const fs = memoryFs({ '/vendor/x.md': 'x' })
    const { agent } = setup(
      steps(
        call('write_file', { path: '/a.txt', content: 'x' }),
        call('write_file', { path: '/Makefile', content: 'x' }),
        call('write_file', { path: '/a.MD', content: 'x' }),
        call('write_file', { path: '/vendor/y.md', content: 'x' }),
        call('edit_file', { path: '/vendor/x.md', old_string: 'x', new_string: 'y' }),
      ),
      { fs, allowedExtensions: ['.md', 'pine'], readonlyPrefixes: ['/vendor/'] },
    )
    const result = await agent.session('s').send('go').result
    expect(outputs(result)).toEqual([
      'REJECTED: /a.txt: extension not allowed (allowed: .md, .pine).',
      'REJECTED: /Makefile: extension not allowed (allowed: .md, .pine).',
      'Created /a.MD (1 bytes).',
      'REJECTED: /vendor/y.md is read-only.',
      'REJECTED: /vendor/x.md is read-only.',
    ])
  })

  test('edit_file errors: missing file, ambiguous match, replace_all', async () => {
    const fs = memoryFs({ '/a.md': 'x\nx\n' })
    const { agent } = setup(
      steps(
        call('edit_file', { path: '/nope.md', old_string: 'a', new_string: 'b' }),
        call('read_file', { path: '/a.md' }),
        call('edit_file', { path: '/a.md', old_string: 'x', new_string: 'y' }),
        call('edit_file', { path: '/a.md', old_string: 'x', new_string: 'y', replace_all: true }),
      ),
      { fs },
    )
    const result = await agent.session('s').send('go').result
    const out = outputs(result) as string[]
    expect(out[0]).toBe('ERROR: file not found: /nope.md (use write_file to create it)')
    expect(out[2]).toStartWith('ERROR: old_string matches 2 places')
    expect(out[3]).toBe('Edited /a.md (2 replacements).')
  })
})

describe('read_file windows, list_files and grep', () => {
  test('offset/limit, continuation hint, maxReadChars, empty file, bad offset', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')
    const fs = memoryFs({ '/long.md': lines, '/empty.md': '' })
    const { agent } = setup(
      steps(
        call('read_file', { path: '/long.md', offset: 28 }),
        call('read_file', { path: '/long.md', offset: 2, limit: 2 }),
        call('read_file', { path: '/long.md' }),
        call('read_file', { path: '/empty.md' }),
        call('read_file', { path: '/long.md', offset: 31 }),
        call('read_file', { path: '/missing.md' }),
      ),
      { fs, maxReadChars: 100 },
    )
    const result = await agent.session('s').send('go').result
    expect(outputs(result)).toEqual([
      '    28\tline 28\n    29\tline 29\n    30\tline 30',
      '     2\tline 2\n     3\tline 3\n\n(Showing lines 2-3 of 30. Continue with offset=4.)',
      // the continuation hint counts toward maxReadChars (100)
      '     1\tline 1\n     2\tline 2\n     3\tline 3\n\n(Showing lines 1-3 of 30. Continue with offset=4.)',
      '(empty file)',
      'ERROR: offset 31 is past the end of the file (30 lines)',
      'ERROR: file not found: /missing.md',
    ])
  })

  test('list_files: sorted with sizes, prefix, hidden and unlisted prefixes', async () => {
    const fs = memoryFs({
      '/src/b.md': 'ø',
      '/src/a.md': 'a',
      '/srcx/c.md': 'c',
      '/private/key.md': 'k',
    })
    const { agent } = setup(
      [
        {
          toolCalls: [
            call('list_files', {}),
            call('list_files', { prefix: '/src/' }),
            call('list_files', { prefix: '/private' }),
            call('list_files', { prefix: '/nothing' }),
          ],
        },
        { text: 'done' },
      ],
      { fs, hiddenPrefixes: ['/private'] },
    )
    const result = await agent.session('s').send('go').result
    expect(outputs(result)).toEqual([
      '/src/a.md (1 bytes)\n/src/b.md (2 bytes)\n/srcx/c.md (1 bytes)',
      '/src/a.md (1 bytes)\n/src/b.md (2 bytes)',
      'No files under /private.',
      'No files under /nothing.',
    ])
  })

  test('grep: hits, prefix, invalid pattern, hidden files, 50-hit cap (fast path and fallback)', async () => {
    const many = Array.from({ length: 60 }, (_, i) => `hit ${i}`).join('\n')
    const seed = {
      '/a.md': 'TODO one\nnothing\n',
      '/src/b.md': 'x\nTODO two',
      '/skills/s/SKILL.md': '---\nname: s\ndescription: TODO hidden\n---\n',
      '/many.md': many,
    }
    for (const withGrep of [true, false]) {
      const inner = memoryFs(seed)
      const fs: FileSystem = withGrep ? inner : { ...inner, grep: undefined }
      const { agent } = setup(
        [
          {
            toolCalls: [
              call('grep', { pattern: 'TODO' }),
              call('grep', { pattern: 'TODO', prefix: '/src' }),
              call('grep', { pattern: '(' }),
              call('grep', { pattern: 'absent' }),
              call('grep', { pattern: '^hit' }),
            ],
          },
          { text: 'done' },
        ],
        { fs, skills: { root: '/skills' } },
      )
      const result = await agent.session('s').send('go').result
      const out = outputs(result) as string[]
      expect(out[0]).toBe('/a.md:1: TODO one\n/src/b.md:2: TODO two')
      expect(out[1]).toBe('/src/b.md:2: TODO two')
      expect(out[2]).toStartWith('ERROR: invalid pattern:')
      expect(out[3]).toBe('No matches.')
      const capped = (out[4] as string).split('\n')
      expect(capped).toHaveLength(51)
      expect(capped[0]).toBe('/many.md:1: hit 0')
      expect(capped[50]).toBe('(Stopped at 50 matches; narrow the pattern or the prefix.)')
    }
  })
})

describe('grep fast path', () => {
  function spied(seed: Record<string, string>) {
    const inner = memoryFs(seed)
    const counts = { grep: 0, read: 0 }
    const fs: FileSystem = {
      ...inner,
      grep: (pattern, opts) => {
        counts.grep++
        return inner.grep?.(pattern, opts) ?? Promise.resolve([])
      },
      read: (path) => {
        counts.read++
        return inner.read(path)
      },
    }
    return { fs, counts }
  }

  test('root grep uses the adapter grep with default options and filters hidden hits', async () => {
    const { fs, counts } = spied({ '/a.md': 'needle', '/skills/s/x.md': 'needle' })
    const { agent } = setup(steps(call('grep', { pattern: 'needle' })), {
      fs,
      skills: { root: '/skills' },
    })
    expect(outputs(await agent.session('s').send('go').result)).toEqual(['/a.md:1: needle'])
    expect(counts).toEqual({ grep: 1, read: 0 })
  })

  test('falls back to list + read when hidden hits use up the adapter budget', async () => {
    const hidden = Array.from({ length: 600 }, () => 'needle').join('\n')
    const { fs, counts } = spied({ '/a/hidden.md': hidden, '/z.md': 'needle' })
    const { agent } = setup(steps(call('grep', { pattern: 'needle' })), {
      fs,
      hiddenPrefixes: ['/a'],
    })
    expect(outputs(await agent.session('s').send('go').result)).toEqual(['/z.md:1: needle'])
    expect(counts).toEqual({ grep: 1, read: 1 })
  })
})

describe('skills autoload and the hidden skills root (scenarios 8 and 9)', () => {
  const skill = (name: string, description: string, body = `Body of ${name}.`) =>
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`

  test('the skills root is hidden from every file tool by default; load_skill reads it', async () => {
    const fs = memoryFs({
      '/skills/pine/SKILL.md': skill('pine', 'Pine help.'),
      '/skills/pine/ref.md': 'reference',
      '/notes.md': 'n',
    })
    const { agent, model } = setup(
      [
        {
          toolCalls: [
            call('list_files', {}),
            call('list_files', { prefix: '/skills' }),
            call('read_file', { path: '/skills/pine/SKILL.md' }),
            call('write_file', { path: '/skills/pine/SKILL.md', content: 'hijack' }),
            call('edit_file', { path: '/skills/pine/ref.md', old_string: 'r', new_string: 'x' }),
            call('delete_file', { path: '/skills/pine/ref.md' }),
            call('grep', { pattern: 'reference', prefix: '/skills' }),
            call('load_skill', { name: 'pine' }),
            call('read_skill_file', { name: 'pine', path: 'ref.md' }),
          ],
        },
        { text: 'done' },
      ],
      { fs, skills: { root: '/skills' } },
    )
    const result = await agent.session('s').send('go').result
    expect(outputs(result)).toEqual([
      '/notes.md (1 bytes)',
      'No files under /skills.',
      'ERROR: file not found: /skills/pine/SKILL.md',
      'REJECTED: /skills/pine/SKILL.md is not accessible.',
      'REJECTED: /skills/pine/ref.md is not accessible.',
      'REJECTED: /skills/pine/ref.md is not accessible.',
      'No matches.',
      '---\nname: pine\ndescription: Pine help.\n---\nBody of pine.\n\nFiles:\n- ref.md (9 bytes)',
      'reference',
    ])
    expect((await fs.read('/skills/pine/SKILL.md'))?.content).toBe(skill('pine', 'Pine help.'))
    const system = (model.calls[0]?.prompt ?? []).filter((m) => m.role === 'system')
    expect(JSON.stringify(system)).toContain('- pine: Pine help.')
  })

  test("refresh 'turn': a SKILL.md written by the agent appears at the next turn, not mid-turn", async () => {
    const fs = memoryFs({ '/skills/first/SKILL.md': skill('first', 'First skill.') })
    const { agent, model } = setup(
      [
        {
          toolCalls: [
            call('write_file', {
              path: '/skills/second/SKILL.md',
              content: skill('second', 'Second skill.', 'two'),
            }),
          ],
        },
        { toolCalls: [call('load_skill', { name: 'second' })] },
        { text: 'turn 1 done' },
        { toolCalls: [call('load_skill', { name: 'second' })] },
        { text: 'turn 2 done' },
      ],
      { fs, skills: { root: '/skills', refresh: 'turn', hideSkillsRoot: false } },
    )
    const session = agent.session('s')
    const first = await session.send('one').result
    expect(outputs(first)).toEqual([
      'Created /skills/second/SKILL.md (52 bytes).',
      'ERROR: skill "second" not found',
    ])
    const indexOf = (i: number) =>
      (model.calls[i]?.prompt ?? [])
        .filter((m) => m.role === 'system')
        .map((m) => (m as { content: string }).content)
        .join('\n')
    expect(indexOf(2)).not.toContain('second')
    const second = await session.send('two').result
    expect(indexOf(3)).toContain('- second: Second skill.')
    expect(outputs(second)).toEqual(['---\nname: second\ndescription: Second skill.\n---\ntwo'])
  })

  test("refresh 'session' keeps the first listing", async () => {
    const fs = memoryFs({ '/skills/first/SKILL.md': skill('first', 'First skill.') })
    const { agent, model } = setup([{ text: 'a' }, { text: 'b' }], {
      fs,
      skills: { root: '/skills' },
    })
    const session = agent.session('s')
    await session.send('one').result
    await fs.write('/skills/second/SKILL.md', skill('second', 'Second.'))
    await session.send('two').result
    expect(JSON.stringify(model.calls[1]?.prompt.filter((m) => m.role === 'system'))).not.toContain(
      'second',
    )
  })

  test('static skills win over fs skills; invalid SKILL.md warns W_INVALID_SKILL; locate reaches skill.load', async () => {
    const fs = memoryFs({
      '/skills/pine/SKILL.md': skill('pine', 'Pine from fs.', 'fs body'),
      '/skills/extra/SKILL.md': skill('extra', 'Extra from fs.'),
      '/skills/broken/SKILL.md': '---\nname: broken\n',
    })
    const seen: unknown[] = []
    const sandbox = definePlugin({
      name: 'sandbox',
      setup: () => ({
        hooks: {
          'skill.load': (_ctx, e) => {
            if (e.source.startsWith('fs:')) seen.push({ source: e.source, location: e.location })
          },
        },
      }),
    })
    const { agent, model, warnings } = setup(
      [
        {
          toolCalls: [call('load_skill', { name: 'pine' }), call('load_skill', { name: 'extra' })],
        },
        { text: 'done' },
      ],
      { fs, skills: { root: '/skills' } },
      {
        skills: [
          defineSkill({ name: 'pine', description: 'Pine static.', content: 'static body' }),
        ],
        plugins: [sandbox],
      },
    )
    const result = await agent.session('s').send('go').result
    const [pine, extra] = outputs(result) as [string, string]
    expect(pine).toContain('static body')
    expect(extra).toContain('Body of extra.')
    const system = (model.calls[0]?.prompt ?? [])
      .filter((m) => m.role === 'system')
      .map((m) => (m as { content: string }).content)
    expect(system.join('\n')).toContain('- pine: Pine static.')
    expect(system.join('\n')).toContain('- extra: Extra from fs.')
    expect(system.join('\n')).not.toContain('Pine from fs.')
    expect(warnings.find((w) => w.code === 'W_SHADOWED')?.details?.source).toBe('fs:/skills')
    const invalid = warnings.filter((w) => w.code === 'W_INVALID_SKILL')
    expect(invalid).toHaveLength(1)
    expect(invalid[0]?.details).toMatchObject({
      source: 'fs:/skills',
      path: '/skills/broken/SKILL.md',
      plugin: 'filesystem',
    })
    expect(seen).toEqual([
      { source: 'fs:/skills', location: { service: 'fs', root: '/skills/extra' } },
    ])
  })
})

describe('services, state and resolver', () => {
  test('lastRead lives in plugin state and survives a restart (new agent, same adapters)', async () => {
    const fs = memoryFs({ '/a.md': 'one' })
    const state = memoryState()
    const first = setup(steps(call('read_file', { path: '/a.md' })), { fs }, {}, state)
    await first.agent.session('s').send('read').result
    const snapshot = await state.get('s')
    expect(snapshot?.plugins.filesystem).toEqual({
      lastRead: { '/a.md': await contentVersion('one') },
    })
    await first.agent.close()
    const second = setup(
      steps(call('edit_file', { path: '/a.md', old_string: 'one', new_string: 'two' })),
      { fs },
      {},
      state,
    )
    const result = await second.agent.session('s').send('edit').result
    expect(outputs(result)).toEqual(['Edited /a.md (1 replacement).'])
  })

  test('ctx.services.fs inside another plugin (requires fs, scenario 10)', async () => {
    const fs = memoryFs({ '/a.md': 'from fs' })
    const reader = definePlugin({
      name: 'reader',
      requires: ['fs'],
      session: (ctx) => ({
        tools: {
          peek: tool({
            inputSchema: z.object({ path: z.string() }),
            execute: async ({ path }) => (await ctx.services.fs.read(path))?.content ?? 'none',
          }),
        },
      }),
    })
    const { agent } = setup(steps(call('peek', { path: '/a.md' })), { fs }, { plugins: [reader] })
    expect(outputs(await agent.session('s').send('go').result)).toEqual(['from fs'])

    // a requirer before its provider is a boot error
    expect(() =>
      defineHarnessAgent({ model: scriptedModel([]), plugins: [reader, filesystem({ fs })] }),
    ).toThrow(expect.objectContaining({ code: 'EH_PLUGIN_ORDER' }))
  })

  test('the fs resolver runs once per session with the session context', async () => {
    const calls: string[] = []
    const perSession = new Map<string, FileSystem>()
    const { agent } = setup(
      [
        { toolCalls: [call('write_file', { path: '/x.md', content: 'x' })] },
        { text: 'a' },
        { toolCalls: [call('list_files', {})] },
        { text: 'b' },
        { toolCalls: [call('list_files', {})] },
        { text: 'c' },
      ],
      {
        fs: (ctx) => {
          calls.push(ctx.session.id)
          const fs = memoryFs()
          perSession.set(ctx.session.id, fs)
          return fs
        },
      },
    )
    await agent.session('one').send('write').result
    const again = await agent.session('one').send('list').result
    const other = await agent.session('two').send('list').result
    expect(calls).toEqual(['one', 'two'])
    expect(outputs(again)).toEqual(['/x.md (1 bytes)'])
    expect(outputs(other)).toEqual(['No files under /.'])
  })

  test('a resolver that returns no FileSystem fails the run with EH_CONFIG_INVALID', async () => {
    const { agent } = setup([{ text: 'x' }], { fs: () => ({}) as FileSystem })
    const result = await agent.session('s').send('go').result
    expect(result.stop).toBe('error')
    expect(JSON.stringify(result)).toContain('EH_CONFIG_INVALID')
  })

  test('toolOutputs service: evicted outputs are readable, read-only and unlisted', async () => {
    const OUT = `/.eharness/tool-outputs/call_1-${(await contentVersion('call/1')).slice(0, 8)}.txt`
    const fs = memoryFs({ '/a.md': 'a' })
    let stored = ''
    const producer = definePlugin({
      name: 'producer',
      requires: ['toolOutputs'],
      session: (ctx) => ({
        tools: {
          produce: tool({
            inputSchema: z.object({}),
            execute: async (_input, { toolCallId }) => {
              stored = await ctx.services.toolOutputs.put(toolCallId, 'line 1\nline 2\n')
              return stored
            },
          }),
        },
      }),
    })
    const { agent } = setup(
      [
        { toolCalls: [{ toolName: 'produce', input: {}, toolCallId: 'call/1' }] },
        {
          toolCalls: [
            call('list_files', {}),
            call('list_files', { prefix: '/.eharness/tool-outputs' }),
            call('read_file', { path: `${OUT}`, offset: 2 }),
            call('write_file', { path: `${OUT}`, content: 'x' }),
            call('delete_file', { path: `${OUT}` }),
            call('grep', { pattern: 'line' }),
            call('grep', { pattern: 'line 2', prefix: '/.eharness' }),
            call('grep', { pattern: 'line 2', prefix: '/.eharness/tool-outputs' }),
          ],
        },
        { text: 'done' },
      ],
      { fs },
      { plugins: [producer] },
    )
    const result = await agent.session('s').send('go').result
    expect(stored).toBe(OUT)
    expect(outputs(result)).toEqual([
      `${OUT}`,
      '/a.md (1 bytes)',
      `${OUT} (14 bytes)`,
      '     2\tline 2',
      `REJECTED: ${OUT} is read-only.`,
      `REJECTED: ${OUT} is read-only.`,
      'No matches.',
      'No matches.',
      `${OUT}:2: line 2`,
    ])
  })

  test('an evicted single-line JSON output is readable completely (charOffset paging)', async () => {
    const OUT = `/.eharness/tool-outputs/call_1-${(await contentVersion('call/1')).slice(0, 8)}.txt`
    const big = JSON.stringify({
      rows: Array.from({ length: 6_000 }, (_, i) => ({ id: i, name: `row-${i}` })),
    })
    expect(big.includes('\n')).toBe(false)
    const produce = tool({ inputSchema: z.object({}), execute: async () => big })
    /** Follow the read_file continuation hints until the line is complete. */
    const next = (options: { prompt: unknown }): ScriptedStep => {
      const results: string[] = []
      for (const message of options.prompt as Array<{ role: string; content: unknown }>) {
        if (message.role !== 'tool' || !Array.isArray(message.content)) continue
        for (const part of message.content as Array<{ toolName?: string; output?: unknown }>) {
          const value = (part.output as { value?: unknown } | undefined)?.value
          if (part.toolName === 'read_file' && typeof value === 'string') results.push(value)
        }
      }
      if (results.length === 0) return { toolCalls: [call('read_file', { path: OUT })] }
      const hint = /charOffset=(\d+)\.\)$/.exec(results.at(-1) ?? '')
      if (hint === null) return { text: 'done' }
      return {
        toolCalls: [call('read_file', { path: OUT, offset: 1, charOffset: Number(hint[1]) })],
      }
    }
    const steps: ScriptedStepInput[] = [
      { toolCalls: [{ toolName: 'produce', input: {}, toolCallId: 'call/1' }] },
      ...Array.from({ length: 30 }, () => next),
    ]
    const { agent } = setup(
      steps,
      { fs: memoryFs(), maxReadChars: 20_000 },
      {
        tools: { produce },
        toolOutput: { perTool: { produce: 2_000 }, strategy: 'evict' },
        contextWindow: 1_000_000,
      },
    )
    const result = await agent.session('s').send('go').result
    expect(result.stop).toBe('complete')
    const segments = toolOutputs(assistant(result))
      .filter(([name]) => name === 'read_file')
      .map(([, output]) =>
        (
          (output as string).slice('     1\t'.length).split('\n\n(Line 1 continues')[0] ?? ''
        ).replace(/ … \[line truncated\]$/, ''),
      )
    expect(segments.length).toBeGreaterThan(5)
    expect(segments.join('')).toBe(big)
  })

  test('grep: a hit beyond the shown 300 characters names its charOffset', async () => {
    const line = `${'x'.repeat(1_000)}NEEDLE${'y'.repeat(100)}`
    const { agent } = setup(
      [
        { toolCalls: [call('grep', { pattern: 'NEEDLE' })] },
        { toolCalls: [call('read_file', { path: '/a.txt', offset: 1, charOffset: 1_000 })] },
        { text: 'done' },
      ],
      { fs: memoryFs({ '/a.txt': `${line}\n` }) },
    )
    const result = await agent.session('s').send('go').result
    const [grep, read] = outputs(result) as string[]
    expect(grep).toBe(`/a.txt:1: ${'x'.repeat(300)} … (match at charOffset=1000)`)
    expect(read).toBe(`     1\tNEEDLE${'y'.repeat(100)}`)
  })

  test('toolOutputs: false provides only fs; a custom dir is honoured', async () => {
    const needs = definePlugin({ name: 'needs', requires: ['toolOutputs'] })
    expect(() =>
      defineHarnessAgent({
        model: scriptedModel([]),
        plugins: [filesystem({ fs: memoryFs(), toolOutputs: false }), needs],
      }),
    ).toThrow(expect.objectContaining({ code: 'EH_SERVICE_MISSING' }))
    const fs = memoryFs()
    let path = ''
    const paths: string[] = []
    const producer = definePlugin({
      name: 'producer',
      requires: ['toolOutputs'],
      session: async (ctx) => {
        path = await ctx.services.toolOutputs.put('abc', 'text')
        paths.push(await ctx.services.toolOutputs.put('a.b', '1'))
        paths.push(await ctx.services.toolOutputs.put('a_b', '2'))
      },
    })
    const { agent } = setup(
      [{ text: 'ok' }],
      { fs, toolOutputs: { dir: 'outputs/' } },
      {
        plugins: [producer],
      },
    )
    await agent.session('s').send('go').result
    expect(path).toBe('/outputs/abc.txt')
    expect((await fs.read('/outputs/abc.txt'))?.content).toBe('text')
    expect(paths[0]).not.toBe(paths[1])
    expect(paths[1]).toBe('/outputs/a_b.txt')
  })

  test('tools option selects the exposed tools', async () => {
    const { agent, model } = setup([{ text: 'ok' }], {
      fs: memoryFs(),
      tools: ['read_file', 'list_files'],
    })
    await agent.session('s').send('go').result
    expect((model.calls[0]?.tools ?? []).map((t) => t.name).sort()).toEqual([
      'list_files',
      'read_file',
    ])
  })
})

describe('filesystem() options validation', () => {
  const invalid = (opts: unknown): boolean => {
    try {
      filesystem(opts as FilesystemOptions)
      return false
    } catch (error) {
      return isHarnessError(error, 'EH_CONFIG_INVALID')
    }
  }
  test('rejects invalid options with EH_CONFIG_INVALID', () => {
    const fs = memoryFs()
    expect(invalid(undefined)).toBe(true)
    expect(invalid({ fs: {} })).toBe(true)
    expect(invalid({ fs, maxReadChars: 0 })).toBe(true)
    expect(invalid({ fs, tools: ['rm_rf'] })).toBe(true)
    expect(invalid({ fs, hiddenPrefixes: ['/../x'] })).toBe(true)
    expect(invalid({ fs, readonlyPrefixes: 'x' })).toBe(true)
    expect(invalid({ fs, allowedExtensions: ['a/b'] })).toBe(true)
    expect(invalid({ fs, isUndeletable: true })).toBe(true)
    expect(invalid({ fs, skills: { root: '' } })).toBe(true)
    expect(invalid({ fs, skills: { root: '/s', refresh: 'never' } })).toBe(true)
    expect(invalid({ fs, toolOutputs: { dir: '/' } })).toBe(true)
    expect(invalid({ fs, toolOutputs: true })).toBe(true)
    expect(invalid({ fs })).toBe(false)
    expect(invalid({ fs: () => fs })).toBe(false)
  })
})
