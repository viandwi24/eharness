import { describe, expect, test } from 'bun:test'
import { QUESTION_TIMEOUT_NOTE, withQuestionTimeout } from '../src/app/ask-timeout.ts'
import type { QuestionRequest } from '../src/contracts.ts'
import { createBroker } from '../src/permissions/index.ts'

const request: QuestionRequest = {
  id: 'q1',
  questions: [
    {
      question: 'Pick?',
      header: 'Pick',
      options: [{ label: 'a' }, { label: 'b' }],
      multiSelect: false,
    },
  ],
}

describe('withQuestionTimeout', () => {
  test('times out: the broker question is dismissed and a note is returned', async () => {
    const broker = createBroker()
    const out = await withQuestionTimeout((signal) => broker.question(request, signal), 0.05)
    expect(out).toEqual({ result: null, timedOut: true, note: QUESTION_TIMEOUT_NOTE })
    expect(broker.pendingQuestions()).toEqual([])
  })

  test('an answer before the timeout wins', async () => {
    const broker = createBroker()
    const pending = withQuestionTimeout((signal) => broker.question(request, signal), 5)
    broker.answerQuestion('q1', { answers: [{ question: 'Pick?', selected: ['a'] }] })
    const out = await pending
    expect(out.timedOut).toBe(false)
    expect(out.result?.answers[0]?.selected).toEqual(['a'])
  })

  test('0 means never; the caller signal still aborts', async () => {
    const broker = createBroker()
    const ac = new AbortController()
    const pending = withQuestionTimeout((signal) => broker.question(request, signal), 0, ac.signal)
    await new Promise((r) => setTimeout(r, 60))
    expect(broker.pendingQuestions()).toHaveLength(1)
    ac.abort()
    expect(await pending).toEqual({ result: null, timedOut: false })
  })
})
