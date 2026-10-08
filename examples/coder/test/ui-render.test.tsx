import { afterEach, describe, expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import { App } from '../src/ui/App.tsx'
import { fakeController } from './fake-controller.ts'

const ENTER = '\r'
const ESC = '\x1b'
const SHIFT_TAB = '\x1b[Z'
const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function until(fn: () => boolean, label: string, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${label}`)
    await tick(10)
  }
}

let cleanup: Array<() => void> = []
afterEach(() => {
  for (const c of cleanup) c()
  cleanup = []
})

function mount(opts: Parameters<typeof fakeController>[0] = {}) {
  const fake = fakeController(opts)
  const app = render(<App controller={fake.controller} />)
  cleanup.push(() => app.unmount())
  const frame = (): string => app.lastFrame() ?? ''
  const type = async (text: string): Promise<void> => {
    app.stdin.write(text)
    await tick()
  }
  return { ...fake, app, frame, type }
}

describe('render', () => {
  test('splash header and status bar', async () => {
    const { frame } = mount()
    await until(() => frame().includes('provider-default'), 'stats')
    expect(frame()).toContain('coder')
    expect(frame()).toContain('/work/project')
    expect(frame()).toContain('test/model')
    expect(frame()).toContain('/help for help')
    expect(frame()).toContain('? for shortcuts')
    expect(frame()).toContain('model · thinking provider-default')
  })

  test('typing, then a prompt and streamed assistant text', async () => {
    const { frame, type, calls } = mount({ script: [{ text: 'Hello from the model' }] })
    await type('hi there')
    expect(frame()).toContain('hi there')
    await type(ENTER)
    await until(() => frame().includes('Hello from the model'), 'assistant text')
    expect(calls).toContain('run:hi there')
    expect(frame()).toContain('> hi there')
  })

  test('tool cards: read_file and an edit with (+N −M)', async () => {
    const { frame, type } = mount({
      script: [
        {
          toolCalls: [
            { toolName: 'read_file', input: { path: '/src/app.ts' }, toolCallId: 'r1' },
            {
              toolName: 'edit_file',
              toolCallId: 'e1',
              input: { path: '/src/app.ts', old_string: 'a\nb\n', new_string: 'a\nB\nC\n' },
            },
          ],
        },
        { text: 'done editing' },
      ],
    })
    await type('go')
    await type(ENTER)
    await until(() => frame().includes('done editing'), 'finish')
    expect(frame()).toContain('Read(src/app.ts)')
    expect(frame()).toContain('Updated src/app.ts with 2 additions and 1 removal')
  })

  test('unknown slash command prints an error', async () => {
    const { frame, type } = mount()
    await type('/bogus')
    await type(ENTER)
    await until(() => frame().includes('Unknown command /bogus'), 'error')
  })

  test('Shift+Tab cycles the mode and the status bar follows', async () => {
    const { frame, type, calls } = mount()
    await until(() => frame().includes('default'), 'status')
    await type(SHIFT_TAB)
    await until(() => frame().includes('accept edits on'), 'acceptEdits')
    expect(calls).toContain('cycleMode')
    await type(SHIFT_TAB)
    await until(() => frame().includes('plan mode on'), 'plan')
  })

  test('Esc while running calls abort', async () => {
    const { type, calls } = mount({ script: [{ text: 'slow', delayMs: 300 }] })
    await type('go')
    await type(ENTER)
    await until(() => calls.includes('run:go'), 'run')
    await tick(50)
    await type(ESC)
    await until(() => calls.includes('abort'), 'abort')
  })

  test('Esc when idle does not abort', async () => {
    const { type, calls } = mount()
    await type(ESC)
    await tick(100)
    expect(calls).not.toContain('abort')
  })

  test('shell mode runs the command without the model', async () => {
    const { frame, type, controller, calls } = mount()
    await type('!echo hi')
    expect(frame()).toContain('shell mode')
    await type(ENTER)
    await until(() => frame().includes('shell out'), 'shell output')
    expect(controller.shellCalls).toEqual(['echo hi'])
    expect(calls.some((c) => c.startsWith('run:'))).toBe(false)
  })

  test('backslash + Enter inserts a newline instead of submitting', async () => {
    const { type, calls, frame } = mount()
    await type('line1\\')
    await type(ENTER)
    await type('line2')
    expect(calls.some((c) => c.startsWith('run:'))).toBe(false)
    expect(frame()).toContain('line1')
    expect(frame()).toContain('line2')
  })

  test('@ mention shows file completions and Tab completes', async () => {
    const { type, frame } = mount()
    await type('see @READ')
    await until(() => frame().includes('@README.md'), 'completion')
    await type('\t')
    await until(() => frame().includes('see @README.md'), 'completed')
  })
})

describe('permission prompt', () => {
  const request = {
    id: 'ap1',
    toolName: 'bash',
    input: { command: 'bun test' },
    title: 'Bash: bun test',
    suggestedRule: 'Bash(bun test *)',
  }

  test('appears for a pending request with its options', async () => {
    const { frame, broker } = mount()
    broker.push(request)
    await until(() => frame().includes('Bash command'), 'prompt')
    expect(frame()).toContain('1. Yes')
    expect(frame()).toContain('No, and tell coder')
  })

  test('key 1 answers approved', async () => {
    const { frame, broker, type } = mount()
    broker.push(request)
    await until(() => frame().includes('Bash command'), 'prompt')
    await type('1')
    await until(() => broker.answers.length === 1, 'answer')
    expect(broker.answers[0]).toEqual({ id: 'ap1', answer: { approved: true } })
    await until(() => !frame().includes('Bash command'), 'prompt gone')
  })

  test('key 2 remembers for the session', async () => {
    const { frame, broker, type } = mount()
    broker.push(request)
    await until(() => frame().includes('Bash command'), 'prompt')
    await type('2')
    await until(() => broker.answers.length === 1, 'answer')
    expect(broker.answers[0]?.answer).toEqual({ approved: true, remember: 'session' })
  })

  test('key 4 denies; Tab on No then feedback + Enter denies with the feedback', async () => {
    const { frame, broker, type } = mount()
    broker.push(request)
    await until(() => frame().includes('Bash command'), 'prompt')
    await type('4')
    await until(() => broker.answers.length === 1, 'answer')
    expect(broker.answers[0]).toEqual({ id: 'ap1', answer: { approved: false } })
    broker.push({ ...request, id: 'ap3' })
    await until(() => frame().includes('Bash command'), 'prompt 2')
    await type('\x1b[B\x1b[B\x1b[B')
    await type('\t')
    await until(() => frame().includes('Tell coder:'), 'field')
    await type('use bun run')
    await type(ENTER)
    await until(() => broker.answers.length === 2, 'answer 2')
    expect(broker.answers[1]).toEqual({
      id: 'ap3',
      answer: { approved: false, feedback: 'use bun run' },
    })
  })

  test('Esc denies; without a rule option 2 is No', async () => {
    const { frame, broker, type } = mount()
    broker.push({ ...request, id: 'ap2', suggestedRule: undefined })
    await until(() => frame().includes('Bash command'), 'prompt')
    expect(frame()).not.toContain('3.')
    await type(ESC)
    await until(() => broker.answers.length === 1, 'answer')
    expect(broker.answers[0]).toEqual({ id: 'ap2', answer: { approved: false } })
  })

  test('typing into the prompt input is blocked while a request is pending', async () => {
    const { frame, broker, type } = mount()
    broker.push(request)
    await until(() => frame().includes('Bash command'), 'prompt')
    await type('x')
    expect(broker.answers).toHaveLength(0)
  })
})

describe('question dialog in the app', () => {
  const single = {
    id: 'q1',
    questions: [
      {
        question: 'Which database?',
        header: 'Database',
        multiSelect: false,
        options: [{ label: 'SQLite' }, { label: 'Postgres' }],
      },
    ],
  }

  test('shows above the prompt, blocks Shift+Tab and answers on Enter', async () => {
    const { frame, broker, type, calls } = mount()
    broker.pushQuestion(single)
    await until(() => frame().includes('Which database?'), 'dialog')
    await type(SHIFT_TAB)
    expect(calls).not.toContain('cycleMode')
    await type('\x1b[B')
    await type(ENTER)
    await until(() => broker.questionAnswers.length === 1, 'answer')
    expect(broker.questionAnswers[0]).toEqual({
      id: 'q1',
      result: { answers: [{ question: 'Which database?', selected: ['Postgres'] }] },
    })
    await until(() => !frame().includes('Which database?'), 'dialog gone')
  })

  test('an approval is shown before a question', async () => {
    const { frame, broker } = mount()
    broker.pushQuestion(single)
    broker.push({ id: 'ap9', toolName: 'bash', input: { command: 'ls' }, title: 'Bash: ls' })
    await until(() => frame().includes('Bash command'), 'approval first')
    expect(frame()).not.toContain('Which database?')
  })
})

describe('session picker', () => {
  test('config.resume === true opens the picker; Enter resumes the selection', async () => {
    const { frame, type, calls } = mount({
      resume: true,
      sessions: [
        { id: 'sess-1', updatedAt: Date.UTC(2026, 0, 2, 3, 4), firstPrompt: 'first session' },
        { id: 'sess-2', updatedAt: Date.UTC(2026, 0, 1, 3, 4), firstPrompt: 'second session' },
      ],
    })
    await until(() => frame().includes('Resume a session'), 'picker')
    expect(frame()).toContain('2026-01-02 03:04')
    expect(frame()).toContain('first session')
    await type('\x1b[B')
    await type(ENTER)
    await until(() => calls.includes('resume:sess-2'), 'resume')
    await until(() => frame().includes('Resumed session sess-2.'), 'note')
    expect(frame()).not.toContain('Resume a session')
  })

  test('no stored sessions: the picker closes itself', async () => {
    const { frame } = mount({ resume: true, sessions: [] })
    await tick(100)
    expect(frame()).not.toContain('Resume a session')
  })

  test('Esc cancels the picker', async () => {
    const { frame, type } = mount({
      resume: true,
      sessions: [{ id: 'a', updatedAt: 0, firstPrompt: 'x' }],
    })
    await until(() => frame().includes('Resume a session'), 'picker')
    await type(ESC)
    await until(() => !frame().includes('Resume a session'), 'closed')
  })
})

describe('review fixes', () => {
  const request = {
    id: 'ap1',
    toolName: 'bash',
    input: {},
    title: 'Bash: bun test',
    suggestedRule: 'Bash(bun test *)',
  }

  test('Shift+Tab is ignored while a permission prompt is open', async () => {
    const { frame, broker, type, calls } = mount()
    broker.push(request)
    await until(() => frame().includes('Bash command'), 'prompt')
    await type(SHIFT_TAB)
    await tick(50)
    expect(calls).not.toContain('cycleMode')
    expect(frame()).toContain('❯ 1. Yes')
    await type('1')
    await until(() => broker.answers.length === 1, 'answer')
    await type(SHIFT_TAB)
    await until(() => calls.includes('cycleMode'), 'cycle after prompt')
  })

  test('Shift+Tab is ignored while the session picker is open', async () => {
    const { frame, type, calls } = mount({
      resume: true,
      sessions: [{ id: 'a', updatedAt: 0, firstPrompt: 'x' }],
    })
    await until(() => frame().includes('Resume a session'), 'picker')
    await type(SHIFT_TAB)
    await tick(50)
    expect(calls).not.toContain('cycleMode')
  })

  test('control characters are stripped from title and detail', async () => {
    const { frame, broker } = mount()
    broker.push({
      ...request,
      title: 'Bash: \x1b[31mred\x1b[0m\x07 cmd',
      detail: 'line \x1b]0;pwned\x07one\x1b[2J\r\ntwo',
    })
    await until(() => frame().includes('line one'), 'prompt')
    expect(frame()).toContain('two')
    expect(frame()).not.toContain('pwned')
    expect(frame()).not.toContain('\x07')
  })

  test('detail shows 20 lines and a "more lines" note', async () => {
    const { frame, broker } = mount()
    broker.push({
      ...request,
      detail: Array.from({ length: 30 }, (_, i) => `row${i}`).join('\n'),
    })
    await until(() => frame().includes('row19'), 'detail')
    expect(frame()).not.toContain('row20')
    expect(frame()).toContain('… 10 more lines')
  })

  test('untrusted project settings show one notice at start', async () => {
    const { frame } = mount({ untrusted: ['allow', 'mcpServers'] })
    await until(() => frame().includes('Project settings ignored until trusted'), 'notice')
    expect(frame()).toContain('allow, mcpServers')
    expect(frame()).toContain('--trust-project')
  })

  test('no notice when trusted', async () => {
    const { frame } = mount()
    await until(() => frame().includes('provider-default'), 'stats')
    expect(frame()).not.toContain('Project settings ignored')
  })

  test('/permissions allow edits rules and /permissions lists them', async () => {
    const { frame, type, calls } = mount()
    await type('/permissions allow Bash(ls) --project')
    await type(ENTER)
    await until(() => frame().includes('Added allow rule Bash(ls)'), 'added')
    expect(calls).toContain('addRule:allow:Bash(ls):project')
    await type('/permissions')
    await type(ENTER)
    await until(() => frame().includes('Permissions'), 'page')
    await until(() => frame().includes('Bash(ls)') && frame().includes('allow (1)'), 'list')
  })

  test('/permissions mode refuses bypassPermissions without --yes', async () => {
    const { frame, type, calls } = mount()
    await type('/permissions mode bypassPermissions')
    await type(ENTER)
    await until(() => frame().includes('Confirm with'), 'refused')
    expect(calls).not.toContain('setMode:bypassPermissions')
  })

  test('/resume unknown shows the controller error', async () => {
    const { frame, type } = mount()
    await type('/resume unknown')
    await type(ENTER)
    await until(() => frame().includes('unknown session'), 'error')
    expect(frame()).not.toContain('Resumed session')
  })

  test('/agents with no runs lists nothing to open', async () => {
    const { frame, type } = mount()
    await type('/agents 1')
    await type(ENTER)
    await until(() => frame().includes('No subagent runs'), 'no runs')
  })
})

describe('custom commands and skills', () => {
  const commands = [
    {
      name: 'review',
      description: 'Review a PR',
      argumentHint: '<pr>',
      source: 'project' as const,
    },
    { name: 'deploy', description: 'Ship it', source: 'skill' as const },
  ]

  test('/ completion lists them with their source and argument hint', async () => {
    const { frame, type } = mount({ commands })
    await tick(60)
    await type('/rev')
    await until(() => frame().includes('/review <pr>'), 'completion')
    expect(frame()).toContain('Review a PR')
    expect(frame()).toContain('(project)')
    await type('\x15')
    await type('/dep')
    await until(() => frame().includes('(skill)'), 'skill')
  })

  test('/name args expands, keeps the typed text visible and runs the expansion', async () => {
    const { frame, type, calls } = mount({ commands, script: [{ text: 'reviewed it' }] })
    await tick(60)
    await type('/review 42')
    await type(ENTER)
    await until(() => calls.includes('expand:review:42'), 'expand')
    await until(() => calls.includes('run:EXPANDED review 42'), 'run')
    await until(() => frame().includes('reviewed it'), 'reply')
    expect(frame()).toContain('> /review 42')
  })

  test('a skill invocation works the same way', async () => {
    const { type, calls } = mount({ commands })
    await tick(60)
    await type('/deploy now')
    await type(ENTER)
    await until(() => calls.includes('run:EXPANDED deploy now'), 'run')
  })

  test('an unknown /name still reports an unknown command', async () => {
    const { frame, type, calls } = mount({ commands })
    await tick(60)
    await type('/nothing')
    await type(ENTER)
    await until(() => frame().includes('Unknown command /nothing'), 'error')
    expect(calls.some((c) => c.startsWith('expand:'))).toBe(false)
  })

  test('/plan description sets plan mode and sends the description', async () => {
    const { frame, type, calls } = mount({ script: [{ text: 'planning' }] })
    await type('/plan add dark mode')
    await type(ENTER)
    await until(() => calls.includes('setMode:plan'), 'mode')
    await until(() => calls.includes('run:add dark mode'), 'run')
    await until(() => frame().includes('plan mode on'), 'footer')
  })
})

describe('plan approval dialog', () => {
  const plan = {
    id: 'pl1',
    toolName: 'exit_plan_mode',
    input: {},
    title: 'Plan',
    detail: '## Steps\n\n- add the **parser**\n- write tests',
  }

  async function open() {
    const m = mount()
    m.broker.push(plan)
    await until(() => m.frame().includes('Ready to code?'), 'dialog')
    return m
  }

  test('renders the plan as markdown with the three options', async () => {
    const { frame } = await open()
    expect(frame()).toContain('Steps')
    expect(frame()).toContain('add the parser')
    expect(frame()).not.toContain('**')
    expect(frame()).toContain('Would you like to proceed?')
    expect(frame()).toContain('1. Yes, and auto-accept edits')
    expect(frame()).toContain('2. Yes, and manually approve edits')
    expect(frame()).toContain('3. No, keep planning')
  })

  test('1 approves with acceptEdits, 2 with default', async () => {
    const { broker, type } = await open()
    await type('1')
    await until(() => broker.answers.length === 1, 'answer')
    expect(broker.answers[0]?.answer).toEqual({ approved: true, mode: 'acceptEdits' })
    broker.push({ ...plan, id: 'pl2' })
    await tick(60)
    await type('2')
    await until(() => broker.answers.length === 2, 'answer 2')
    expect(broker.answers[1]?.answer).toEqual({ approved: true, mode: 'default' })
  })

  test('3 keeps planning; Tab on 3 sends feedback; Tab on 1 adds a note; Esc is option 3', async () => {
    const { broker, type, frame } = await open()
    await type('3')
    await until(() => broker.answers.length === 1, 'answer')
    expect(broker.answers[0]?.answer).toEqual({ approved: false })

    broker.push({ ...plan, id: 'pl2' })
    await until(() => frame().includes('Ready to code?'), 'again')
    await type('\x1b[B\x1b[B')
    await type('\t')
    await until(() => frame().includes('Tell coder:'), 'field')
    await type('split step two')
    await type(ENTER)
    await until(() => broker.answers.length === 2, 'answer 2')
    expect(broker.answers[1]?.answer).toEqual({ approved: false, feedback: 'split step two' })

    broker.push({ ...plan, id: 'pl3' })
    await until(() => frame().includes('Ready to code?'), 'third')
    await type('\t')
    await until(() => frame().includes('Note:'), 'note field')
    await type('go fast')
    await type(ENTER)
    await until(() => broker.answers.length === 3, 'answer 3')
    expect(broker.answers[2]?.answer).toEqual({
      approved: true,
      mode: 'acceptEdits',
      note: 'go fast',
    })

    broker.push({ ...plan, id: 'pl4' })
    await until(() => frame().includes('Ready to code?'), 'fourth')
    await type(ESC)
    await until(() => broker.answers.length === 4, 'answer 4')
    expect(broker.answers[3]?.answer).toEqual({ approved: false })
  })
})
