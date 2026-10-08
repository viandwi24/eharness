import { describe, expect, test } from 'bun:test'
import type { Question } from '../src/contracts.ts'
import {
  buildAnswer,
  initialQuestionState,
  type QuestionAction,
  type QuestionState,
  questionReduce,
  unanswered,
} from '../src/ui/question-state.ts'

const radio: Question = {
  question: 'Which db?',
  header: 'DB',
  multiSelect: false,
  options: [{ label: 'A' }, { label: 'B' }],
}
const multi: Question = {
  question: 'Which features?',
  header: 'Features',
  multiSelect: true,
  options: [{ label: 'X' }, { label: 'Y' }, { label: 'Z' }],
}

function run(state: QuestionState, ...actions: QuestionAction[]) {
  let step = { state, submit: false, dismiss: false }
  for (const a of actions) step = questionReduce(step.state, a)
  return step
}
const text = (s: string): QuestionAction[] => [...s].map((input) => ({ type: 'text', input }))

describe('question state', () => {
  test('single radio: Enter selects and submits', () => {
    const step = run(initialQuestionState([radio]), { type: 'move', delta: 1 }, { type: 'enter' })
    expect(step.submit).toBe(true)
    expect(buildAnswer(step.state).answers).toEqual([{ question: 'Which db?', selected: ['B'] }])
  })

  test('radio: number selects without advancing, Enter then moves to the next tab', () => {
    const s0 = initialQuestionState([radio, multi])
    const s1 = run(s0, { type: 'number', n: 2 })
    expect(s1.state.picked[0]).toEqual([1])
    expect(s1.state.tab).toBe(0)
    const s2 = run(s1.state, { type: 'enter' })
    expect(s2.state.tab).toBe(1)
    expect(s2.submit).toBe(false)
  })

  test('checkbox: Space toggles, Enter moves on, last tab is Submit', () => {
    const s = run(
      initialQuestionState([multi, radio]),
      { type: 'space' },
      { type: 'move', delta: 1 },
      { type: 'move', delta: 1 },
      { type: 'space' },
      { type: 'space' },
      { type: 'number', n: 2 },
      { type: 'enter' },
    )
    expect(s.state.picked[0]).toEqual([0, 1])
    expect(s.state.tab).toBe(1)
  })

  test('Other row: typing fills it, replaces the radio choice, Enter confirms', () => {
    const s = run(
      initialQuestionState([radio]),
      { type: 'number', n: 1 },
      { type: 'move', delta: -1 },
      ...text('n1x'),
      { type: 'enter' },
    )
    expect(s.submit).toBe(true)
    expect(buildAnswer(s.state).answers[0]).toEqual({
      question: 'Which db?',
      selected: [],
      other: 'n1x',
    })
  })

  test('Esc in the Other input only closes it; Esc elsewhere dismisses', () => {
    const typed = run(initialQuestionState([radio]), { type: 'move', delta: -1 }, ...text('hi'))
    const closed = run(typed.state, { type: 'escape' })
    expect(closed.dismiss).toBe(false)
    expect(closed.state.cursor[0]).toBe(0)
    expect(run(closed.state, { type: 'escape' }).dismiss).toBe(true)
  })

  test('notes: n opens, text is kept on Esc, answer carries it', () => {
    const s = run(initialQuestionState([radio]), { type: 'notes' }, ...text('because'), {
      type: 'escape',
    })
    expect(s.state.notesOpen).toBe(false)
    expect(s.dismiss).toBe(false)
    const done = run(s.state, { type: 'number', n: 1 }, { type: 'enter' })
    expect(buildAnswer(done.state).answers[0]?.notes).toBe('because')
  })

  test('Submit tab warns about unanswered radio questions but allows empty checkboxes', () => {
    const base = initialQuestionState([radio, multi])
    const onSubmit = run(base, { type: 'tab', delta: -1 })
    expect(onSubmit.state.tab).toBe(2)
    expect(unanswered(onSubmit.state)).toEqual([0])
    const warned = run(onSubmit.state, { type: 'enter' })
    expect(warned.submit).toBe(false)
    expect(warned.state.warn).toBe(true)
    const ok = run(base, { type: 'number', n: 1 }, { type: 'tab', delta: -1 }, { type: 'enter' })
    expect(ok.submit).toBe(true)
    expect(buildAnswer(ok.state).answers[1]?.selected).toEqual([])
  })
})
