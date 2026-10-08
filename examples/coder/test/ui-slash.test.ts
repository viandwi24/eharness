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
  const pages: unknown[] = []
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
    pickModel: () => void calls.push('pickModel'),
    pickThinking: () => void calls.push('pickThinking'),
    openPage: (page) => void pages.push(page),
    subagents: () => runs,
    showTranscript: (title, messages) => void transcripts.push({ title, messages }),
    submit: (p) => void calls.push(`submit:${p}`),
    todos: () => [{ id: '1', content: 'do it', status: 'in_progress' }] as never,
    setModelLabel: (m) => void calls.push(`label:${m}`),
    refreshStats: () => void calls.push('refresh'),
    exit: () => void calls.push('exit'),
    openRewind: () => void calls.push('openRewind'),
    sideQuestion: (q) => void calls.push(`side:${q}`),
    pickOutputStyle: () => void calls.push('pickOutputStyle'),
    applyTheme: (t) => void calls.push(`theme:${t}`),
    applyEditorMode: (m) => void calls.push(`editor:${m}`),
    toggleFocus: () => void calls.push('focus'),
    copy: async (t) => {
      calls.push(`copy:${t}`)
      return 'pbcopy'
    },
    refreshTitle: () => void calls.push('title'),
  }
  return { ctx, calls, printed, runs, transcripts, pages }
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
    expect(matchSlash('/re').map((c) => c.name)).toEqual(['resume', 'rewind', 'rename', 'recap'])
    expect(matchSlash('/c').map((c) => c.name)).toEqual([
      'clear',
      'compact',
      'context',
      'cost',
      'copy',
      'config',
    ])
    expect(matchSlash('/').length).toBe(slashCommands.length)
    expect(matchSlash('/model x')).toEqual([])
    expect(matchSlash('nope')).toEqual([])
  })

  test('matchSlash lists custom commands and skills after the built-ins, never shadowing them', () => {
    const custom = [
      { name: 'review', description: 'Review', argumentHint: '<pr>', source: 'project' as const },
      { name: 'clear', description: 'shadow', source: 'user' as const },
      { name: 'deploy', description: 'Ship', source: 'skill' as const },
    ]
    const hits = matchSlash('/', custom)
    expect(hits.slice(-2).map((c) => [c.name, c.usage, c.source])).toEqual([
      ['review', '<pr>', 'project'],
      ['deploy', undefined, 'skill'],
    ])
    expect(hits.filter((c) => c.name === 'clear')).toHaveLength(1)
    expect(matchSlash('/rev', custom).map((c) => c.name)).toEqual(['review'])
  })

  test('every documented command exists', () => {
    expect(slashCommands.map((c) => c.name)).toEqual([
      'help',
      'clear',
      'compact',
      'context',
      'status',
      'cost',
      'model',
      'thinking',
      'permissions',
      'agents',
      'transcript',
      'resume',
      'todos',
      'diff',
      'plan',
      'rewind',
      'branch',
      'rename',
      'export',
      'copy',
      'btw',
      'recap',
      'add-dir',
      'memory',
      'config',
      'tasks',
      'doctor',
      'output-style',
      'theme',
      'sandbox',
      'vim',
      'focus',
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

  test('/help, /context, /status, /cost open their page', async () => {
    const h = harness()
    for (const name of ['help', 'context', 'status', 'cost']) await runSlash(`/${name}`, h.ctx)
    expect(h.pages).toEqual([
      { kind: 'help' },
      { kind: 'context' },
      { kind: 'status' },
      { kind: 'cost' },
    ])
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

  test('/model opens the picker or switches', async () => {
    const h = harness()
    await runSlash('/model', h.ctx)
    expect(h.calls).toEqual(['pickModel'])
    await runSlash('/model new-model', h.ctx)
    expect(h.calls).toEqual(['pickModel', 'setModel:new-model', 'label:new-model', 'refresh'])
  })

  test('/thinking opens the picker, sets a level, rejects an unknown one', async () => {
    const h = harness({ setThinking: (l: string) => void h.calls.push(`setThinking:${l}`) })
    await runSlash('/thinking', h.ctx)
    await runSlash('/thinking high', h.ctx)
    await runSlash('/thinking turbo', h.ctx)
    expect(h.calls).toEqual(['pickThinking', 'setThinking:high', 'refresh'])
    expect(h.printed[0]?.text).toBe('Thinking set to high.')
    expect(h.printed[1]).toMatchObject({ tone: 'error' })
  })

  test('/permissions, /agents open pages; /todos prints', async () => {
    const h = harness()
    await runSlash('/permissions', h.ctx)
    await runSlash('/agents', h.ctx)
    expect(h.pages).toEqual([{ kind: 'permissions' }, { kind: 'agents' }])
    await runSlash('/todos', h.ctx)
    expect(h.printed[0]?.text).toContain('◐ do it')
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

  test('/diff opens the diff page; /plan sets plan mode and sends its description', async () => {
    const h = harness()
    await runSlash('/diff', h.ctx)
    expect(h.pages).toEqual([{ kind: 'diff' }])
    await runSlash('/plan', h.ctx)
    await runSlash('/plan add a login page', h.ctx)
    expect(h.calls).toEqual(['setMode:plan', 'setMode:plan', 'submit:add a login page'])
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
