import { afterEach, describe, expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import type { ApprovalRequest, QuestionRequest } from '../src/contracts.ts'
import { TOOL } from '../src/contracts.ts'
import { PermissionPrompt } from '../src/ui/PermissionPrompt.tsx'
import { QuestionDialog } from '../src/ui/QuestionDialog.tsx'
import { ToolCard } from '../src/ui/ToolCard.tsx'
import { fakeBroker } from './fake-controller.ts'

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const ANSI = /\u001b\[[0-9;]*m/g
const plain = (frame: string | undefined): string => (frame ?? '').replace(ANSI, '')
const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))
const ENTER = '\r'
const ESC = '\x1b'
const TAB = '\t'
const SHIFT_TAB = '\x1b[Z'
const DOWN = '\x1b[B'
const RIGHT = '\x1b[C'

let cleanup: Array<() => void> = []
afterEach(() => {
  for (const c of cleanup) c()
  cleanup = []
})

function show(node: React.ReactElement) {
  const app = render(node)
  cleanup.push(() => app.unmount())
  return {
    text: (): string => plain(app.lastFrame()),
    press: async (keys: string): Promise<void> => {
      app.stdin.write(keys)
      await tick(60)
    },
  }
}

const bash: ApprovalRequest = {
  id: 'a1',
  toolName: TOOL.bash,
  input: { command: 'bun test' },
  title: 'Bash: bun test',
  detail: 'bun test',
  suggestedRule: 'Bash(bun test *)',
}

async function prompt(request = bash) {
  const broker = fakeBroker()
  broker.push(request)
  const ui = show(<PermissionPrompt broker={broker} />)
  await tick(30)
  return { broker, ...ui }
}

describe('PermissionPrompt comments', () => {
  test('Tab on Yes opens a field; typing + Enter sends the note', async () => {
    const { broker, press, text } = await prompt()
    await press(TAB)
    expect(text()).toContain('Note: ')
    expect(text()).toContain('Enter to send · Tab to close')
    await press('use the cache')
    await press(ENTER)
    expect(broker.answers).toEqual([
      { id: 'a1', answer: { approved: true, note: 'use the cache' } },
    ])
  })

  test('Tab on No then Enter sends feedback; an empty field sends none', async () => {
    const { broker, press } = await prompt()
    await press('\x1b[B\x1b[B\x1b[B')
    await press(TAB)
    await press('try bun run')
    await press(ENTER)
    expect(broker.answers[0]?.answer).toEqual({ approved: false, feedback: 'try bun run' })
    const again = await prompt({ ...bash, id: 'a2', suggestedRule: undefined })
    await again.press(DOWN)
    await again.press(TAB)
    await again.press(ENTER)
    expect(again.broker.answers[0]?.answer).toEqual({ approved: false })
  })

  test('Tab closes the field and keeps the text for a later Enter', async () => {
    const { broker, press, text } = await prompt()
    await press(TAB)
    await press('later')
    await press(TAB)
    expect(broker.answers).toHaveLength(0)
    expect(text()).not.toContain('Enter to send')
    expect(text()).toContain('Note: later')
    await press(ENTER)
    expect(broker.answers[0]?.answer).toEqual({ approved: true, note: 'later' })
  })

  test('Shift+Tab closes the field like Tab; reopening is prefilled', async () => {
    const { broker, press, text } = await prompt()
    await press(TAB)
    await press('abc')
    await press(SHIFT_TAB)
    expect(broker.answers).toHaveLength(0)
    await press(TAB)
    expect(text()).toContain('Note: abc')
    await press('d')
    await press(ENTER)
    expect(broker.answers[0]?.answer).toEqual({ approved: true, note: 'abcd' })
  })

  test('Tab on a "don\'t ask again" option does nothing', async () => {
    const { broker, press, text } = await prompt()
    await press(DOWN)
    await press(TAB)
    expect(text()).not.toContain('Enter to send')
    await press(ENTER)
    expect(broker.answers[0]?.answer).toEqual({ approved: true, remember: 'session' })
  })

  test('Esc in the field closes only the field; Esc outside denies', async () => {
    const { broker, press, text } = await prompt()
    await press(TAB)
    await press('x')
    await press(ESC)
    await tick(80)
    expect(broker.answers).toHaveLength(0)
    expect(text()).not.toContain('Enter to send')
    await press(ESC)
    await tick(80)
    expect(broker.answers[0]?.answer).toEqual({ approved: false })
  })

  test('shows the hint line and the open field', async () => {
    const { press, text } = await prompt({ ...bash, agent: 'reviewer' })
    expect(text()).toContain('Tab to add a note · Esc to cancel')
    expect(text()).toContain('(from reviewer)')
    await press(TAB)
    await press('why')
  })
})

const two: QuestionRequest = {
  id: 'q1',
  agent: 'planner',
  questions: [
    {
      question: 'Which auth method?',
      header: 'Auth',
      multiSelect: false,
      options: [
        { label: 'OAuth', description: 'Delegate to a provider' },
        { label: 'Password', description: 'Local accounts' },
      ],
    },
    {
      question: 'Which features?',
      header: 'Features',
      multiSelect: true,
      options: [{ label: 'Audit log' }, { label: 'SSO' }],
    },
  ],
}

async function dialog(request: QuestionRequest) {
  const broker = fakeBroker()
  broker.pushQuestion(request)
  const ui = show(<QuestionDialog broker={broker} />)
  await tick(30)
  return { broker, ...ui }
}

describe('QuestionDialog', () => {
  test('single radio question: Enter answers, no Submit tab', async () => {
    const { broker, press, text } = await dialog({ id: 'q0', questions: two.questions.slice(0, 1) })
    expect(text()).not.toContain('Submit')
    expect(text()).toContain('1. ( ) OAuth')
    await press(DOWN)
    await press(ENTER)
    expect(broker.questionAnswers).toEqual([
      {
        id: 'q0',
        result: { answers: [{ question: 'Which auth method?', selected: ['Password'] }] },
      },
    ])
  })

  test('two questions: tabs, checkboxes, Other, notes, review, submit', async () => {
    const { broker, press, text } = await dialog(two)
    expect(text()).toContain('☐ Auth')
    expect(text()).toContain('✔ Submit')
    expect(text()).toContain('(from planner)')
    await press('1')
    await press(ENTER) // next tab
    expect(text()).toContain('☒ Auth')
    expect(text()).toContain('[ ] Audit log')
    await press(' ') // toggle first
    await press(DOWN)
    await press(DOWN) // Other row
    await press('Vault')
    expect(text()).toContain('Vault')
    await press(ENTER) // other confirmed -> Submit tab
    expect(text()).toContain('Review your answers')
    expect(text()).toContain('Features → Audit log, Vault')
    await press(SHIFT_TAB)
    await press('\x1b[A')
    await press('n')
    await press('careful')
    await press(ENTER)
    await press(RIGHT)
    expect(text()).toContain('Features → Audit log, Vault')
    expect(text()).toContain('Notes: careful')
    await press(ENTER)
    expect(broker.questionAnswers[0]).toEqual({
      id: 'q1',
      result: {
        answers: [
          { question: 'Which auth method?', selected: ['OAuth'] },
          {
            question: 'Which features?',
            selected: ['Audit log'],
            other: 'Vault',
            notes: 'careful',
          },
        ],
      },
    })
  })

  test('submit with an unanswered radio question warns and does not answer', async () => {
    const { broker, press, text } = await dialog(two)
    await press(RIGHT)
    await press(RIGHT)
    await press(ENTER)
    expect(text()).toContain('Answer every question first')
    expect(broker.questionAnswers).toHaveLength(0)
  })

  test('Esc dismisses; Esc inside the notes input only closes it', async () => {
    const { broker, press, text } = await dialog(two)
    await press('n')
    expect(text()).toContain('Notes: ')
    await press(ESC)
    await tick(80)
    expect(broker.questionAnswers).toHaveLength(0)
    await press(ESC)
    await tick(80)
    expect(broker.questionAnswers).toEqual([{ id: 'q1', result: null }])
  })

  test('render of a 2-question dialog', async () => {
    const { press, text } = await dialog(two)
    await press('1')
    expect(text()).toContain('Delegate to a provider')
  })
})

describe('ask_user_question tool card', () => {
  const base = {
    toolName: TOOL.ask,
    toolCallId: 'c',
    state: 'output-available' as const,
    input: { questions: two.questions },
  }
  test('headers and answers', () => {
    const out = show(
      <ToolCard
        view={{ ...base, output: 'The user answered:\n- Auth: OAuth\n- Features: SSO' }}
        context={{}}
        expanded={false}
      />,
    ).text()
    expect(out).toContain('Ask(Auth, Features)')
    expect(out).toContain('⎿')
    expect(out).toContain('- Auth: OAuth')
  })
  test('dismissed', () => {
    const out = show(
      <ToolCard
        view={{ ...base, output: 'The user dismissed the questions.' }}
        context={{}}
        expanded={false}
      />,
    ).text()
    expect(out).toContain('Dismissed')
  })
})
