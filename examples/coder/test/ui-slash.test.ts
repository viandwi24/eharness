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
import type { SubagentRun } from '../src/ui/state.ts'

function harness(over: Record<string, unknown> = {}) {
  const calls: string[] = []
  const printed: Array<{ text: string; tone?: string }> = []
  const rules = { allow: ['Bash(ls)'], ask: [] as string[], deny: ['Read(./.env)'] }
  const runs: SubagentRun[] = []
  const transcripts: Array<{ title: string; messages: unknown[] }> = []
  const controller = {
    permissions: {
      mode: 'plan',
      rules: () => rules,
      setMode: (m: string) => void calls.push(`setMode:${m}`),
      addRule: async (k: string, r: string, scope: string) => {
        if (r === 'bad') throw new Error('invalid rule')
        calls.push(`addRule:${k}:${r}:${scope}`)
      },
      removeRule: async (k: string, r: string) => {
        calls.push(`removeRule:${k}:${r}`)
        return r !== 'missing'
      },
    },
    messagesOf: async (id: string) => [{ id: `m-${id}`, role: 'assistant', parts: [] }],
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
    subagents: () => runs,
    showTranscript: (title, messages) => void transcripts.push({ title, messages }),
    submit: (p) => void calls.push(`submit:${p}`),
    todos: () => [{ id: '1', content: 'do it', status: 'in_progress' }] as never,
    setModelLabel: (m) => void calls.push(`label:${m}`),
    refreshStats: () => void calls.push('refresh'),
    exit: () => void calls.push('exit'),
  }
  return { ctx, calls, printed, runs, transcripts }
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
      'transcript',
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

  test('/resume <id> surfaces the controller error instead of claiming success', async () => {
    const h = harness({
      resume: async () => {
        throw new Error('unknown session')
      },
    })
    await runSlash('/resume nope', h.ctx)
    expect(h.printed).toHaveLength(1)
    expect(h.printed[0]).toMatchObject({ tone: 'error' })
    expect(h.printed[0]?.text).toContain('unknown session')
    expect(h.calls).not.toContain('load')
    expect(slashCommands.find((c) => c.name === 'resume')?.usage).toBe('[id]')
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

describe('/permissions editing', () => {
  test('addRule: session by default, project with --project', async () => {
    const h = harness()
    await runSlash('/permissions allow Bash(bun test *)', h.ctx)
    await runSlash('/permissions deny Read(./.env) --project', h.ctx)
    await runSlash('/permissions ask Edit(src/**)', h.ctx)
    expect(h.calls).toEqual([
      'addRule:allow:Bash(bun test *):session',
      'addRule:deny:Read(./.env):project',
      'addRule:ask:Edit(src/**):session',
    ])
    expect(h.printed[1]?.text).toContain('project')
  })

  test('remove calls removeRule and reports a missing rule', async () => {
    const h = harness()
    await runSlash('/permissions remove allow Bash(ls)', h.ctx)
    await runSlash('/permissions remove deny missing', h.ctx)
    expect(h.calls).toEqual(['removeRule:allow:Bash(ls)', 'removeRule:deny:missing'])
    expect(h.printed[0]).toMatchObject({ tone: 'info' })
    expect(h.printed[1]).toMatchObject({ tone: 'error' })
  })

  test('an engine error becomes a system error line', async () => {
    const h = harness()
    await runSlash('/permissions allow bad', h.ctx)
    expect(h.printed[0]).toMatchObject({ tone: 'error' })
    expect(h.printed[0]?.text).toContain('invalid rule')
  })

  test('usage errors', async () => {
    const h = harness()
    await runSlash('/permissions allow', h.ctx)
    await runSlash('/permissions remove nope x', h.ctx)
    await runSlash('/permissions wat', h.ctx)
    expect(h.calls).toEqual([])
    for (const p of h.printed) expect(p.tone).toBe('error')
  })

  test('mode sets a mode; bypassPermissions needs --yes', async () => {
    const h = harness()
    await runSlash('/permissions mode acceptEdits', h.ctx)
    await runSlash('/permissions mode bypassPermissions', h.ctx)
    await runSlash('/permissions mode nonsense', h.ctx)
    expect(h.calls).toEqual(['setMode:acceptEdits'])
    expect(h.printed[1]).toMatchObject({ tone: 'error' })
    expect(h.printed[1]?.text).toContain('--yes')
    expect(h.printed[2]).toMatchObject({ tone: 'error' })
    await runSlash('/permissions mode bypassPermissions --yes', h.ctx)
    expect(h.calls).toEqual(['setMode:acceptEdits', 'setMode:bypassPermissions'])
  })
})

describe('/agents runs and transcripts', () => {
  const run = (n: number): SubagentRun => ({
    toolCallId: `c${n}`,
    name: 'explore',
    description: `task ${n}`,
    sessionId: `child-${n}`,
    status: n === 2 ? 'running' : 'done',
  })

  test('lists definitions and numbered runs', async () => {
    const h = harness()
    h.runs.push(run(1), run(2))
    await runSlash('/agents', h.ctx)
    const text = h.printed[0]?.text ?? ''
    expect(text).toContain('explore (builtin): finds things')
    expect(text).toContain('1. explore [done]: task 1')
    expect(text).toContain('2. explore [running]: task 2')
  })

  test('/agents <n> and /transcript <n> load the child messages', async () => {
    const h = harness()
    h.runs.push(run(1), run(2))
    await runSlash('/agents 2', h.ctx)
    await runSlash('/transcript 1', h.ctx)
    expect(h.transcripts.map((t) => t.title)).toEqual(['explore: task 2', 'explore: task 1'])
    expect(h.transcripts[0]?.messages[0]).toMatchObject({ id: 'm-child-2' })
  })

  test('bad numbers print an error', async () => {
    const h = harness()
    await runSlash('/agents 1', h.ctx)
    expect(h.printed[0]).toMatchObject({ tone: 'error' })
    h.runs.push(run(1))
    await runSlash('/agents 9', h.ctx)
    await runSlash('/agents x', h.ctx)
    expect(h.printed[1]?.text).toContain('1-1')
    expect(h.printed[2]).toMatchObject({ tone: 'error' })
    expect(h.transcripts).toEqual([])
  })
})
