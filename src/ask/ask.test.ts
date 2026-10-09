import { describe, expect, test } from 'bun:test'
import { defineHarnessAgent, type PendingState } from '../index.ts'
import { scriptedModel } from '../testing/scripted-model.ts'
import {
  answerOutput,
  askUser,
  formatAnswers,
  type PendingQuestion,
  parseQuestions,
  pendingQuestions,
  type Question,
} from './index.ts'

const QUESTIONS: Question[] = [
  {
    question: 'Which database?',
    header: 'Database',
    options: [{ label: 'SQLite', description: 'embedded' }, { label: 'Postgres' }],
    multiSelect: false,
  },
  {
    question: 'Which features?',
    header: 'Features',
    options: [{ label: 'Auth' }, { label: 'Billing' }, { label: 'Search' }],
    multiSelect: true,
  },
]

describe('formatAnswers', () => {
  test('selected, other, notes and missing answers', () => {
    expect(
      formatAnswers(QUESTIONS, {
        answers: [
          { selected: ['SQLite'], notes: 'keep it simple' },
          { other: ' Cache ', selected: ['Auth', 'Billing'] },
        ],
      }),
    ).toBe(
      'The user answered:\n- Database: SQLite\n  notes: keep it simple\n- Features: Auth, Billing; other: "Cache"',
    )
    expect(formatAnswers(QUESTIONS, { answers: [] })).toBe(
      'The user answered:\n- Database: (no answer)\n- Features: (no answer)',
    )
  })

  test('dismissed', () => {
    expect(formatAnswers(QUESTIONS, null)).toBe(
      'The user dismissed the questions without answering. Proceed with your best judgment or ask in plain text.',
    )
  })
})

describe('parseQuestions / pendingQuestions / answerOutput', () => {
  test('validates 1-4 questions, 2-4 options, header length', () => {
    expect('questions' in parseQuestions({ questions: QUESTIONS })).toBe(true)
    for (const bad of [
      { questions: [] },
      { questions: [{ ...QUESTIONS[0], options: [{ label: 'a' }] }] },
      { questions: [{ ...QUESTIONS[0], header: 'a header too long' }] },
      { questions: Array(5).fill(QUESTIONS[0]) },
    ]) {
      expect(parseQuestions(bad)).toHaveProperty('error')
    }
    expect(parseQuestions({ questions: QUESTIONS }, { maxQuestions: 1 })).toHaveProperty('error')
  })

  test('extracts calls from the pending state', () => {
    const pending = {
      messageId: 'm',
      approvals: [],
      clientTools: [
        { toolCallId: 'a', toolName: 'ask_user_question', input: { questions: QUESTIONS } },
        { toolCallId: 'b', toolName: 'ask_user_question', input: { questions: [] } },
        { toolCallId: 'c', toolName: 'ask_user_question', inputTruncated: true },
        { toolCallId: 'd', toolName: 'ask_user_question', inputTruncated: true },
        { toolCallId: 'e', toolName: 'other', input: {} },
      ],
    } as PendingState
    const found = pendingQuestions(pending, {
      storedInputs: { c: { questions: QUESTIONS } },
    })
    expect(found.map((f) => f.toolCallId)).toEqual(['a', 'b', 'c', 'd'])
    expect(found[0]?.questions).toEqual(QUESTIONS)
    expect(found[1]?.error).toStartWith('Invalid ask_user_question input')
    expect(found[2]?.questions).toEqual(QUESTIONS)
    expect(found[3]?.error).toContain('not available')
    expect(answerOutput(found[0] as PendingQuestion, null)).toEqual({
      toolCallId: 'a',
      output: formatAnswers(QUESTIONS, null),
    })
    expect(answerOutput(found[0] as PendingQuestion, { answers: [] }, 'note')).toMatchObject({
      output: expect.stringMatching(/\n\nnote$/),
    })
    expect(answerOutput(found[1] as PendingQuestion, null)).toEqual({
      toolCallId: 'b',
      errorText: found[1]?.error as string,
    })
    expect(pendingQuestions(null)).toEqual([])
  })
})

const call = (toolName = 'ask_user_question') => ({
  toolCalls: [{ toolName, toolCallId: 'q1', input: { questions: QUESTIONS } }],
})

describe('askUser in a session', () => {
  test('interactive: tool-pending, answered through respond({ toolOutputs })', async () => {
    const model = scriptedModel([call(), { text: 'SQLite it is.' }])
    const agent = defineHarnessAgent({ model, contextWindow: 100_000, plugins: [askUser()] })
    const session = agent.session('s1')
    const first = await session.send('plan').result
    expect(first.stop).toBe('tool-pending')
    const [q] = pendingQuestions(first.pending)
    expect(q?.questions).toEqual(QUESTIONS)
    const run = session.respond({
      toolOutputs: [
        answerOutput(q as PendingQuestion, {
          answers: [{ selected: ['SQLite'] }, { selected: ['Auth'] }],
        }),
      ],
    })
    expect((await run.result).stop).toBe('complete')
    expect(JSON.stringify(model.prompts[1])).toContain('The user answered:')
    await agent.close()
  })

  test.each([
    ['dismiss' as const, 'dismissed the questions'],
    ['error' as const, 'ERROR: no user is available'],
    [
      () => ({ answers: [{ selected: ['Postgres'] }, { selected: ['Search'] }] }),
      '- Database: Postgres',
    ],
  ])('non-interactive fallback %#', async (whenNoHuman, expected) => {
    const model = scriptedModel([call(), { text: 'done' }])
    const agent = defineHarnessAgent({
      model,
      contextWindow: 100_000,
      plugins: [askUser({ interactive: false, whenNoHuman })],
    })
    const result = await agent.session('s2').send('plan').result
    expect(result.stop).toBe('complete')
    expect(JSON.stringify(model.prompts[1])).toContain(expected)
    await agent.close()
  })

  test('interactive as a function of the context, custom tool name', async () => {
    const model = scriptedModel([call('ask_me'), { text: 'done' }])
    const agent = defineHarnessAgent({
      model,
      contextWindow: 100_000,
      plugins: [askUser({ toolName: 'ask_me', interactive: (ctx) => ctx.runtime.human === true })],
    })
    const session = agent.session('s3', { runtime: { human: false } })
    expect((await session.send('plan').result).stop).toBe('complete')
    await agent.close()
  })
})
