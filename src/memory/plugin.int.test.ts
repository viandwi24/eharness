import { describe, expect, test } from 'bun:test'
import { tool } from 'ai'
import { z } from 'zod/v4'
import { memoryFs } from '../filesystem/memory.ts'
import { filesystem } from '../filesystem/plugin.ts'
import {
  defineHarnessAgent,
  type HarnessAgentConfig,
  type HarnessWarning,
  isHarnessError,
} from '../index.ts'
import { memoryMessages, memoryState } from '../storage/memory.ts'
import { type ScriptedCallOptions, scriptedModel } from '../testing/scripted-model.ts'
import {
  MEMORY_PROTOCOL,
  MEMORY_TOOLS,
  type MemoryCommand,
  type MemoryExecutor,
  type MemoryOptions,
  type MemoryWriteEvent,
  memory,
} from './index.ts'
import { trimMiddle } from './plugin.ts'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

const userRoots: MemoryOptions['roots'] = (ctx) => [
  { path: `/memories/users/${String(ctx.runtime.userId)}`, write: true, label: 'this user' },
  { path: '/memories/org', label: 'company knowledge' },
]

function setup(
  config: Partial<HarnessAgentConfig> & Pick<HarnessAgentConfig, 'model'>,
  options: Partial<MemoryOptions> = {},
  seed: Record<string, string> = {},
) {
  const warnings: HarnessWarning[] = []
  const fs = memoryFs(seed)
  const agent = defineHarnessAgent({
    contextWindow: 100_000,
    storage: { messages: memoryMessages(), state: memoryState() },
    logger: silent,
    onWarning: (w) => warnings.push(w),
    plugins: [
      filesystem({ fs, hiddenPrefixes: ['/memories'] }),
      memory({ roots: userRoots, ...options }),
    ],
    ...config,
  })
  return { agent, warnings, fs }
}

const call = (toolName: string, input: Record<string, unknown>) => ({
  toolCalls: [{ toolName, input }],
})
const text = (value: unknown) => JSON.stringify(value)
const systemOf = (c: ScriptedCallOptions | undefined) =>
  (c?.prompt ?? []).filter((m) => m.role === 'system')
const toolNamesOf = (c: ScriptedCallOptions | undefined) => (c?.tools ?? []).map((t) => t.name)

describe('memory plugin', () => {
  test('six tools in a stable order, the protocol in block 1, roots in the turn reminder', async () => {
    const model = scriptedModel([
      call('memory_create', { path: '/memories/users/u1/notes.md', file_text: 'likes tea\n' }),
      call('memory_view', { path: '/memories/users/u1/notes.md' }),
      { text: 'noted' },
    ])
    const { agent, fs } = setup({ model })
    const result = await agent.session('s1', { runtime: { userId: 'u1' } }).send('remember').result
    expect(result.stop).toBe('complete')
    const tools = toolNamesOf(model.calls[0])
    expect(tools.filter((name) => name.startsWith('memory_'))).toEqual([...MEMORY_TOOLS])
    expect(text(systemOf(model.calls[0]))).toContain(MEMORY_PROTOCOL.slice(0, 60))
    expect(text(systemOf(model.calls[0]))).not.toContain('/memories/users/u1')
    const prompt = text(model.calls[0]?.prompt)
    expect(prompt).toContain(
      'Memory roots:\\n- /memories/users/u1/ (writable): this user\\n- /memories/org/ (read-only): company knowledge',
    )
    expect(text(model.calls[1]?.prompt)).toContain('Created /memories/users/u1/notes.md.')
    expect(text(model.calls[2]?.prompt)).toContain('     1\\tlikes tea')
    expect((await fs.read('/memories/users/u1/notes.md'))?.content).toBe('likes tea\n')
    await agent.close()
  })

  test('roots are resolved once per turn from ctx.runtime', async () => {
    const model = scriptedModel([
      call('memory_create', { path: '/memories/users/u1/a.md', file_text: 'a' }),
      call('memory_view', { path: '/memories/users/u1' }),
      { text: 'turn 1' },
      call('memory_view', { path: '/memories/users/u1/a.md' }),
      { text: 'turn 2' },
    ])
    let calls = 0
    const { agent } = setup(
      { model },
      {
        roots: (ctx) => {
          calls++
          return userRoots(ctx)
        },
      },
    )
    const session = agent.session('s1', { runtime: { userId: 'u1' } })
    await session.send('one').result
    expect(calls).toBe(1)
    await session.send('two', { runtime: { userId: 'u2' } }).result
    expect(calls).toBe(2)
    expect(text(model.calls[4]?.prompt)).toContain(
      'REJECTED: /memories/users/u1/a.md is outside the memory roots.',
    )
    expect(text(model.calls[3]?.prompt)).toContain('/memories/users/u2/ (writable)')
    await agent.close()
  })

  test('pinned files are in the turn reminder (trimmed), never in the instructions', async () => {
    const seed = {
      '/memories/users/u1/profile.md': `Name: Ada\n${'x'.repeat(5000)}\nEND-OF-PROFILE\n`,
      '/memories/org/policy.md': 'Be kind.\n',
      '/memories/users/u2/profile.md': 'Name: Bob\n',
    }
    const model = scriptedModel([{ text: 'hi' }])
    const { agent } = setup(
      { model },
      {
        maxPinnedChars: 600,
        pinned: (ctx) => [
          `/memories/users/${String(ctx.runtime.userId)}/profile.md`,
          '/memories/org/policy.md',
          '/memories/users/u2/profile.md', // outside the roots of u1: skipped
          '/memories/users/u1/missing.md', // missing: skipped
        ],
      },
      seed,
    )
    await agent.session('s1', { runtime: { userId: 'u1' } }).send('hello').result
    const prompt = model.calls[0]?.prompt ?? []
    expect(text(systemOf(model.calls[0]))).not.toContain('Ada')
    const reminder = prompt
      .filter((m) => m.role === 'user')
      .map((m) => text(m))
      .find((m) => m.includes('Memory roots'))
    expect(reminder).toContain('<pinned path=\\"/memories/users/u1/profile.md\\">\\nName: Ada')
    expect(reminder).toContain('END-OF-PROFILE')
    expect(reminder).toContain('characters omitted; view the file for the full text')
    expect(reminder).toContain('<pinned path=\\"/memories/org/policy.md\\">\\nBe kind.\\n</pinned>')
    expect(reminder).not.toContain('Bob')
    expect(reminder).toContain('<system-reminder>')
    await agent.close()
  })

  test('prompt-cache golden: tools and instructions block 1 are identical across users', async () => {
    const model = scriptedModel([{ text: 'a' }, { text: 'b' }])
    const { agent } = setup(
      { model },
      { pinned: (ctx) => [`/memories/users/${String(ctx.runtime.userId)}/profile.md`] },
      {
        '/memories/users/u1/profile.md': 'Ada',
        '/memories/users/u2/profile.md': 'Bob',
      },
    )
    await agent.session('s1', { runtime: { userId: 'u1' } }).send('hi').result
    await agent.session('s2', { runtime: { userId: 'u2' } }).send('hi').result
    const [a, b] = model.calls
    expect(text(systemOf(a))).toBe(text(systemOf(b)))
    expect(text(a?.tools)).toBe(text(b?.tools))
    expect(text(a?.prompt)).toContain('Ada')
    expect(text(b?.prompt)).toContain('Bob')
    await agent.close()
  })

  test('onWrite is called once per successful write; its error is W_HOOK_FAILED', async () => {
    const model = scriptedModel([
      call('memory_create', { path: '/memories/users/u1/a.md', file_text: 'a' }),
      call('memory_create', { path: '/memories/users/u1/a.md', file_text: 'again' }),
      call('memory_delete', { path: '/memories/users/u1/a.md' }),
      { text: 'done' },
    ])
    const events: Array<{ event: MemoryWriteEvent; session: string }> = []
    const { agent, warnings } = setup(
      { model },
      {
        onWrite: (event, ctx) => {
          events.push({ event, session: ctx.session.id })
          if (event.op === 'delete') throw new Error('audit down')
        },
      },
    )
    await agent.session('s1', { runtime: { userId: 'u1' } }).send('go').result
    expect(events.map((e) => [e.event.op, e.event.path, e.session])).toEqual([
      ['create', '/memories/users/u1/a.md', 's1'],
      ['delete', '/memories/users/u1/a.md', 's1'],
    ])
    expect(events[0]?.event.toolCallId).toBe('call-0-0')
    expect(text(model.calls[3]?.prompt)).toContain('Deleted /memories/users/u1/a.md.')
    const failed = warnings.filter((w) => w.code === 'W_HOOK_FAILED')
    expect(failed).toHaveLength(1)
    expect(failed[0]?.message).toContain('audit down')
    expect(failed[0]?.details).toMatchObject({ hook: 'onWrite', plugin: 'memory' })
    await agent.close()
  })

  test('the tool option replaces the six tools and receives a working executor', async () => {
    const model = scriptedModel([
      call('memory', { command: 'create', path: '/memories/users/u1/a.md', file_text: 'a' }),
      call('memory', { command: 'view', path: '/memories/users/u1/a.md' }),
      { text: 'done' },
    ])
    let received: MemoryExecutor | undefined
    const { agent, fs } = setup(
      { model },
      {
        tool: (execute) => {
          received = execute
          return tool({
            description: 'Memory (provider-shaped input).',
            inputSchema: z.object({ command: z.string() }).passthrough(),
            execute: (input, { toolCallId }) => execute(input as MemoryCommand, { toolCallId }),
          })
        },
      },
    )
    await agent.session('s1', { runtime: { userId: 'u1' } }).send('go').result
    const tools = toolNamesOf(model.calls[0])
    expect(tools).toContain('memory')
    expect(tools.some((name) => name.startsWith('memory_'))).toBe(false)
    expect(typeof received).toBe('function')
    expect((await fs.read('/memories/users/u1/a.md'))?.content).toBe('a')
    expect(text(model.calls[2]?.prompt)).toContain('     1\\ta')
    await agent.close()
  })

  test('protocol false removes the static instruction', async () => {
    const model = scriptedModel([{ text: 'ok' }])
    const { agent } = setup({ model }, { protocol: false })
    await agent.session('s1', { runtime: { userId: 'u1' } }).send('hi').result
    expect(text(systemOf(model.calls[0]))).not.toContain(MEMORY_PROTOCOL.slice(0, 40))
    expect(text(model.calls[0]?.prompt)).toContain('Memory roots:')
    await agent.close()
  })

  test('a failing roots resolver fails the turn before anything is stored', async () => {
    const model = scriptedModel([{ text: 'never' }])
    const { agent } = setup(
      { model },
      {
        roots: () => {
          throw new Error('no tenant')
        },
      },
    )
    const session = agent.session('s1')
    const result = await session.send('hi').result
    expect(result.stop).toBe('error')
    expect(model.calls).toHaveLength(0)
    await agent.close()
  })

  test('boot and option errors', () => {
    const model = scriptedModel([])
    let error: unknown
    try {
      defineHarnessAgent({ model, contextWindow: 1000, plugins: [memory({ roots: () => [] })] })
    } catch (e) {
      error = e
    }
    expect(isHarnessError(error, 'EH_SERVICE_MISSING')).toBe(true)
    const bad: unknown[] = [
      undefined,
      {},
      { roots: [] },
      { roots: () => [], pinned: [] },
      { roots: () => [], maxPinnedChars: -1 },
      { roots: () => [], maxFileChars: 0 },
      { roots: () => [], protocol: 1 },
      { roots: () => [], tool: {} },
    ]
    for (const options of bad) {
      let thrown: unknown
      try {
        memory(options as MemoryOptions)
      } catch (e) {
        thrown = e
      }
      expect(isHarnessError(thrown, 'EH_CONFIG_INVALID')).toBe(true)
    }
  })
})

describe('trimMiddle', () => {
  test('keeps head and tail within the budget', () => {
    expect(trimMiddle('short', 10)).toBe('short')
    const long = `${'a'.repeat(500)}${'b'.repeat(500)}`
    const out = trimMiddle(long, 200)
    expect(out.length).toBeLessThanOrEqual(200)
    expect(out.startsWith('aaa')).toBe(true)
    expect(out.endsWith('bbb')).toBe(true)
    expect(out).toContain('characters omitted')
    expect(trimMiddle(long, 10)).toBe('aaaaaaaaaa')
  })
})
