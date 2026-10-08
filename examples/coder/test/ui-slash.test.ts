import { describe, expect, test } from 'bun:test'
import type { CoderController } from '../src/contracts.ts'
import {
  INIT_PROMPT,
  matchSlash,
  parseSlash,
  runSlash,
  type SlashContext,
  slashCommands,
} from '../src/ui/slash.ts'

function harness(over: Record<string, unknown> = {}) {
  const calls: string[] = []
  const printed: Array<{ text: string; tone?: string }> = []
  const controller = {
    permissions: {
      mode: 'plan',
      rules: () => ({ allow: ['Bash(ls)'], ask: [], deny: ['Read(./.env)'] }),
    },
    clear: async () => void calls.push('clear'),
    compact: async () => void calls.push('compact'),
    setModel: (m: string) => void calls.push(`setModel:${m}`),
    agents: () => [{ name: 'explore', source: 'builtin', description: 'finds things' }],
    resume: async (id: string) => void calls.push(`resume:${id}`),
    messages: async () => [],
    stats: async () => ({ contextTokens: 2500, contextWindow: 10_000, costUsd: 0.0123 }),
    ...over,
  } as unknown as CoderController
  const ctx: Omit<SlashContext, 'args'> = {
    controller,
    model: 'm0',
    print: (text, tone) => void printed.push({ text, tone }),
    reset: () => void calls.push('reset'),
    load: () => void calls.push('load'),
    pickSession: () => void calls.push('pick'),
    submit: (p) => void calls.push(`submit:${p}`),
    todos: () => [{ id: '1', content: 'do it', status: 'in_progress' }] as never,
    setModelLabel: (m) => void calls.push(`label:${m}`),
    refreshStats: () => void calls.push('refresh'),
    exit: () => void calls.push('exit'),
  }
  return { ctx, calls, printed }
}

describe('slash parsing', () => {
  test('parseSlash', () => {
    expect(parseSlash('/model gpt')).toEqual({ name: 'model', args: 'gpt' })
    expect(parseSlash('  /help  ')).toEqual({ name: 'help', args: '' })
    expect(parseSlash('/resume a b')).toEqual({ name: 'resume', args: 'a b' })
    expect(parseSlash('hello /x')).toBeNull()
    expect(parseSlash('/')).toBeNull()
    expect(parseSlash('/ x')).toBeNull()
  })

  test('matchSlash by prefix', () => {
    expect(matchSlash('/re').map((c) => c.name)).toEqual(['resume'])
    expect(matchSlash('/c').map((c) => c.name)).toEqual(['clear', 'compact', 'cost'])
    expect(matchSlash('/').length).toBe(slashCommands.length)
    expect(matchSlash('/model x')).toEqual([])
    expect(matchSlash('nope')).toEqual([])
  })

  test('every documented command exists', () => {
    expect(slashCommands.map((c) => c.name)).toEqual([
      'help',
      'clear',
      'compact',
      'model',
      'permissions',
      'agents',
      'resume',
      'cost',
      'todos',
      'init',
      'exit',
    ])
  })
})

describe('slash effects', () => {
  test('not a slash command returns false', async () => {
    const h = harness()
    expect(await runSlash('hello', h.ctx)).toBe(false)
  })

  test('unknown command prints an error', async () => {
    const h = harness()
    expect(await runSlash('/nope', h.ctx)).toBe(true)
    expect(h.printed[0]).toMatchObject({ tone: 'error' })
    expect(h.printed[0]?.text).toContain('/nope')
  })

  test('/help lists every command', async () => {
    const h = harness()
    await runSlash('/help', h.ctx)
    for (const c of slashCommands) expect(h.printed[0]?.text).toContain(`/${c.name}`)
    expect(h.printed[0]?.text).toContain('shift+tab')
  })

  test('/clear clears the controller, resets the view, refreshes stats', async () => {
    const h = harness()
    await runSlash('/clear', h.ctx)
    expect(h.calls).toEqual(['clear', 'reset', 'refresh'])
  })

  test('/compact success and failure', async () => {
    const h = harness()
    await runSlash('/compact', h.ctx)
    expect(h.calls).toEqual(['compact', 'refresh'])
    expect(h.printed.map((p) => p.text)).toEqual([
      'Compacting the conversation…',
      'Conversation compacted.',
    ])
    const bad = harness({
      compact: async () => {
        throw new Error('nope')
      },
    })
    await runSlash('/compact', bad.ctx)
    expect(bad.printed[1]).toMatchObject({ tone: 'error' })
    expect(bad.printed[1]?.text).toContain('nope')
  })

  test('/model shows or switches', async () => {
    const h = harness()
    await runSlash('/model', h.ctx)
    expect(h.printed[0]?.text).toContain('m0')
    expect(h.calls).toEqual([])
    await runSlash('/model new-model', h.ctx)
    expect(h.calls).toEqual(['setModel:new-model', 'label:new-model', 'refresh'])
  })

  test('/permissions, /agents, /cost, /todos', async () => {
    const h = harness()
    await runSlash('/permissions', h.ctx)
    expect(h.printed[0]?.text).toContain('Mode: plan')
    expect(h.printed[0]?.text).toContain('allow: Bash(ls)')
    expect(h.printed[0]?.text).toContain('ask: (none)')
    await runSlash('/agents', h.ctx)
    expect(h.printed[1]?.text).toContain('explore (builtin): finds things')
    await runSlash('/cost', h.ctx)
    expect(h.printed[2]?.text).toBe('Context: 2.5k / 10.0k tokens (25%) · cost $0.0123')
    await runSlash('/todos', h.ctx)
    expect(h.printed[3]?.text).toContain('◐ do it')
    const none = harness({ agents: () => [] })
    await runSlash('/agents', none.ctx)
    expect(none.printed[0]?.text).toBe('No subagents defined.')
  })

  test('/resume without an id opens the picker, with an id resumes', async () => {
    const h = harness()
    await runSlash('/resume', h.ctx)
    expect(h.calls).toEqual(['pick'])
    await runSlash('/resume abc', h.ctx)
    expect(h.calls).toEqual(['pick', 'resume:abc', 'load', 'refresh'])
    const bad = harness({
      resume: async () => {
        throw new Error('missing')
      },
    })
    await runSlash('/resume x', bad.ctx)
    expect(bad.printed[0]).toMatchObject({ tone: 'error' })
  })

  test('/init submits the fixed prompt and /exit exits', async () => {
    const h = harness()
    await runSlash('/init', h.ctx)
    await runSlash('/exit', h.ctx)
    expect(h.calls).toEqual([`submit:${INIT_PROMPT}`, 'exit'])
  })

  test('a throwing command is reported as an error line', async () => {
    const h = harness({
      clear: async () => {
        throw new Error('x')
      },
    })
    expect(await runSlash('/clear', h.ctx)).toBe(true)
    expect(h.printed[0]).toMatchObject({ tone: 'error' })
  })
})
