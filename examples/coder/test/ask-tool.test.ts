/** `ask_user_question`: client tool round trip through driveTurn, formatting, print mode, subagents. */
import { describe, expect, test } from 'bun:test'
import type { HarnessSession } from 'eharness'
import { scriptedModel } from 'eharness/testing'
import { createAskTool, driveTurn, formatAnswers, parseQuestions } from '../src/agents/index.ts'
import type { CoderMessage, QuestionRequest } from '../src/contracts.ts'
import { createDenyingBroker } from '../src/permissions/broker.ts'
import { makeAgentsEnv } from './helpers.ts'

const QUESTIONS = [
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
  {
    question: 'Which runtime?',
    header: 'Runtime',
    options: [{ label: 'Bun' }, { label: 'Node' }],
    multiSelect: false,
  },
]
const ask = (input: unknown = { questions: QUESTIONS }) => ({
  toolName: 'ask_user_question',
  input,
})

async function setup(steps: Parameters<typeof scriptedModel>[0], broker?: never) {
  const model = scriptedModel(steps)
  const env = await makeAgentsEnv({ model, ...(broker ? { broker } : {}) })
  const session = env.agents.main.session('s1') as never as HarnessSession<CoderMessage>
  const drive = (text = 'go', signal?: AbortSignal) =>
    driveTurn(session.send(text, { abortSignal: signal }), {
      session,
      broker: env.broker,
      permissions: env.permissions,
      describe: env.describe,
      signal,
      stopOnBareDeny: true,
    })
  return { model, env, session, drive }
}

async function nextQuestion(broker: { pendingQuestions(): QuestionRequest[] }) {
  const start = Date.now()
  for (;;) {
    const [first] = broker.pendingQuestions()
    if (first !== undefined) return first
    if (Date.now() - start > 5000) throw new Error('timed out waiting for a question')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('formatAnswers', () => {
  const request: QuestionRequest = { id: 'x', questions: QUESTIONS as never }
  test('radio, checkbox, other and notes', () => {
    expect(
      formatAnswers(request, {
        answers: [
          { question: 'Which database?', selected: ['SQLite'], notes: 'only for tests' },
          { question: 'Which features?', selected: ['Auth', 'Search'], other: 'Audit log' },
          { question: 'Which runtime?', selected: [], other: 'Deno' },
        ],
      }),
    ).toBe(
      [
        'The user answered:',
        '- Database: SQLite',
        '  notes: only for tests',
        '- Features: Auth, Search; other: "Audit log"',
        '- Runtime: other: "Deno"',
      ].join('\n'),
    )
  })
  test('dismissed', () => {
    expect(formatAnswers(request, null)).toBe(
      'The user dismissed the questions without answering. Proceed with your best judgment or ask in plain text.',
    )
  })
})

describe('parseQuestions', () => {
  test('accepts valid input and explains invalid input', () => {
    expect('questions' in parseQuestions({ questions: QUESTIONS })).toBe(true)
    const bad = parseQuestions({ questions: [{ ...QUESTIONS[0], options: [{ label: 'one' }] }] })
    expect('error' in bad && bad.error).toContain('questions.0.options')
    expect('error' in parseQuestions({ questions: [] })).toBe(true)
    expect(
      'error' in parseQuestions({ questions: [{ ...QUESTIONS[0], header: 'a'.repeat(13) }] }),
    ).toBe(true)
  })
  test('the tool is a client tool', () => {
    expect((createAskTool() as { execute?: unknown }).execute).toBeUndefined()
  })
})

describe('ask_user_question round trip', () => {
  test('the answers reach the model as the tool result', async () => {
    const { drive, env, model } = await setup([{ toolCalls: [ask()] }, { text: 'thanks' }])
    const turn = drive()
    const request = await nextQuestion(env.broker)
    expect(request.questions).toHaveLength(3)
    expect(request.agent).toBeUndefined()
    env.broker.answerQuestion(request.id, {
      answers: [
        { question: 'Which database?', selected: ['SQLite'], notes: 'only for tests' },
        { question: 'Which features?', selected: ['Auth', 'Search'], other: 'Audit log' },
        { question: 'Which runtime?', selected: ['Bun'] },
      ],
    })
    const result = await turn
    expect(result.stop).toBe('complete')
    const wire = JSON.stringify(model.prompts[1])
    const expected = [
      'The user answered:',
      '- Database: SQLite',
      '  notes: only for tests',
      '- Features: Auth, Search; other: "Audit log"',
      '- Runtime: Bun',
    ].join('\n')
    expect(wire).toContain(JSON.stringify(expected).slice(1, -1))
  })

  test('dismissed: the model reads the dismissal text', async () => {
    const { drive, env, model } = await setup([{ toolCalls: [ask()] }, { text: 'ok' }])
    const turn = drive()
    env.broker.answerQuestion((await nextQuestion(env.broker)).id, null)
    expect((await turn).stop).toBe('complete')
    expect(JSON.stringify(model.prompts[1])).toContain('The user dismissed the questions')
  })

  test('invalid input is an error the model can read; no dialog is shown', async () => {
    const { drive, env, model } = await setup([
      { toolCalls: [ask({ questions: [{ ...QUESTIONS[0], options: [{ label: 'one' }] }] })] },
      { text: 'fixing' },
    ])
    const result = await drive()
    expect(result.stop).toBe('complete')
    expect(env.broker.pendingQuestions()).toEqual([])
    // the AI SDK rejects the input before the client tool is reported; the model reads that error
    expect(JSON.stringify(model.prompts[1])).toContain('Invalid input for tool ask_user_question')
  })

  test('works in plan mode', async () => {
    const { drive, env, model } = await setup([{ toolCalls: [ask()] }, { text: 'ok' }])
    env.permissions.setMode('plan')
    const turn = drive()
    env.broker.answerQuestion((await nextQuestion(env.broker)).id, null)
    expect((await turn).stop).toBe('complete')
    expect(model.prompts).toHaveLength(2)
  })

  test('aborting while the dialog is open ends the turn and removes the question', async () => {
    const { drive, env } = await setup([{ toolCalls: [ask()] }, { text: 'never' }])
    const abort = new AbortController()
    const turn = drive('go', abort.signal)
    await nextQuestion(env.broker)
    abort.abort()
    expect((await turn).stop).not.toBe('complete')
    expect(env.broker.pendingQuestions()).toEqual([])
  })

  test('print mode (denying broker): dismissal text, the turn completes', async () => {
    const model = scriptedModel([{ toolCalls: [ask()] }, { text: 'ok' }])
    const env = await makeAgentsEnv({ model, broker: createDenyingBroker() })
    const session = env.agents.main.session('s1') as never as HarnessSession<CoderMessage>
    const result = await driveTurn(session.send('go'), {
      session,
      broker: env.broker,
      permissions: env.permissions,
      describe: env.describe,
    })
    expect(result.stop).toBe('complete')
    expect(JSON.stringify(model.prompts[1])).toContain('The user dismissed the questions')
  })

  test('main offers the tool, subagents do not', async () => {
    const main = scriptedModel([{ text: 'hi' }])
    const env = await makeAgentsEnv({ model: main })
    const s = env.agents.main.session('t') as never as HarnessSession<CoderMessage>
    await s.send('go').result
    const names = (m: typeof main) =>
      ((m.calls?.[0]?.tools ?? []) as Array<{ name: string }>).map((t) => t.name)
    expect(names(main)).toContain('ask_user_question')

    const child = scriptedModel([{ text: 'done' }])
    const env2 = await makeAgentsEnv({ model: child })
    const def = env2.definitions.find((d) => d.name === 'general-purpose')
    if (def === undefined) throw new Error('no general-purpose definition')
    const c = env2.agents.agentFor(def, 1).session('c') as never as HarnessSession<CoderMessage>
    await c.send('go').result
    expect(names(child)).not.toContain('ask_user_question')
  })
})
