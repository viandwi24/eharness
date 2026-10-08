/** Pure state machine of the question dialog (`ask_user_question`), no React and no Ink. */
import type { Question, QuestionAnswer } from '../contracts.ts'
import { type Buffer, backspace, deleteForward, emptyBuffer, insert, move } from './editor.ts'

/** State of the dialog. Arrays are indexed by question. */
export interface QuestionState {
  questions: Question[]
  /** Active tab: a question index, or `questions.length` for the Submit tab. */
  tab: number
  /** Cursor row per question: an option index, or `options.length` for the Other row. */
  cursor: number[]
  /** Chosen option indexes per question (radio: at most one). */
  picked: number[][]
  /** Text of the Other row per question. */
  other: Buffer[]
  /** Free notes per question. */
  notes: Buffer[]
  /** The notes input of the active question is open. */
  notesOpen: boolean
  /** The Submit tab was tried while a radio question was unanswered. */
  warn: boolean
}

/** What the user did. */
export type QuestionAction =
  | { type: 'move'; delta: -1 | 1 }
  | { type: 'tab'; delta: -1 | 1 }
  | { type: 'space' }
  | { type: 'number'; n: number }
  | { type: 'enter' }
  | { type: 'notes' }
  | { type: 'escape' }
  | { type: 'text'; input: string }
  | { type: 'edit'; op: 'backspace' | 'delete' | 'left' | 'right' }

/** Result of {@link questionReduce}: the next state and whether to submit it. */
export interface QuestionStep {
  state: QuestionState
  submit: boolean
  /** The user dismissed the dialog. */
  dismiss: boolean
}

/** Initial state of a request. */
export function initialQuestionState(questions: Question[]): QuestionState {
  return {
    questions,
    tab: 0,
    cursor: questions.map(() => 0),
    picked: questions.map(() => []),
    other: questions.map(() => emptyBuffer),
    notes: questions.map(() => emptyBuffer),
    notesOpen: false,
    warn: false,
  }
}

/** True when the dialog has a Submit tab (more than one question). */
export function hasSubmitTab(state: QuestionState): boolean {
  return state.questions.length > 1
}

/** True while the Submit tab is active. */
export function onSubmitTab(state: QuestionState): boolean {
  return hasSubmitTab(state) && state.tab === state.questions.length
}

/** True when the cursor of the active question is on the Other row. */
export function onOtherRow(state: QuestionState): boolean {
  const q = state.questions[state.tab]
  return q !== undefined && state.cursor[state.tab] === q.options.length
}

/** True when question `i` has an answer (a picked option or Other text). */
export function isAnswered(state: QuestionState, i: number): boolean {
  return (state.picked[i]?.length ?? 0) > 0 || (state.other[i]?.text.trim() ?? '') !== ''
}

/** Radio questions that still need an answer (checkbox questions may stay empty). */
export function unanswered(state: QuestionState): number[] {
  return state.questions.flatMap((q, i) => (!q.multiSelect && !isAnswered(state, i) ? [i] : []))
}

/** Human text of one answer: chosen labels, Other text. */
export function answerText(state: QuestionState, i: number): string {
  const q = state.questions[i]
  if (!q) return ''
  const labels = [...(state.picked[i] ?? [])]
    .sort((a, b) => a - b)
    .map((n) => q.options[n]?.label ?? '')
  const other = state.other[i]?.text.trim() ?? ''
  return [...labels, ...(other ? [other] : [])].join(', ')
}

/** The answer sent to the broker. */
export function buildAnswer(state: QuestionState): QuestionAnswer {
  return {
    answers: state.questions.map((q, i) => {
      const selected = [...(state.picked[i] ?? [])]
        .sort((a, b) => a - b)
        .map((n) => q.options[n]?.label ?? '')
      const other = state.other[i]?.text.trim() ?? ''
      const notes = state.notes[i]?.text.trim() ?? ''
      return {
        question: q.question,
        selected,
        ...(other ? { other } : {}),
        ...(notes ? { notes } : {}),
      }
    }),
  }
}

function set<T>(list: T[], i: number, value: T): T[] {
  return list.map((v, j) => (j === i ? value : v))
}

function editBuffer(buf: Buffer, action: QuestionAction): Buffer {
  if (action.type === 'text') return insert(buf, action.input.replace(/[\r\n]+/g, ' '))
  if (action.type !== 'edit') return buf
  switch (action.op) {
    case 'backspace':
      return backspace(buf)
    case 'delete':
      return deleteForward(buf)
    case 'left':
      return move(buf, -1)
    case 'right':
      return move(buf, 1)
  }
}

/** Choose option `n` of the active question (radio: replace and clear Other; checkbox: toggle). */
function choose(state: QuestionState, n: number): QuestionState {
  const q = state.questions[state.tab]
  if (!q || n < 0 || n >= q.options.length) return state
  const current = state.picked[state.tab] ?? []
  let next: number[]
  if (q.multiSelect) next = current.includes(n) ? current.filter((v) => v !== n) : [...current, n]
  else next = [n]
  return {
    ...state,
    warn: false,
    picked: set(state.picked, state.tab, next),
    cursor: set(state.cursor, state.tab, n),
    other: q.multiSelect ? state.other : set(state.other, state.tab, emptyBuffer),
  }
}

function goTab(state: QuestionState, tab: number): QuestionState {
  const count = state.questions.length + (hasSubmitTab(state) ? 1 : 0)
  return { ...state, tab: ((tab % count) + count) % count, notesOpen: false, warn: false }
}

function nextOrSubmit(state: QuestionState): QuestionStep {
  if (!hasSubmitTab(state)) return { state, submit: true, dismiss: false }
  return { state: goTab(state, state.tab + 1), submit: false, dismiss: false }
}

/** Apply one user action. */
export function questionReduce(state: QuestionState, action: QuestionAction): QuestionStep {
  const keep = (s: QuestionState): QuestionStep => ({ state: s, submit: false, dismiss: false })
  const q = state.questions[state.tab]

  if (action.type === 'tab') return keep(goTab(state, state.tab + action.delta))

  // Submit tab
  if (!q) {
    if (action.type === 'escape') return { state, submit: false, dismiss: true }
    if (action.type === 'enter') {
      if (unanswered(state).length > 0) return keep({ ...state, warn: true })
      return { state, submit: true, dismiss: false }
    }
    return keep(state)
  }

  // notes input
  if (state.notesOpen) {
    if (action.type === 'escape' || action.type === 'enter')
      return keep({ ...state, notesOpen: false })
    if (action.type === 'text' || action.type === 'edit') {
      return keep({
        ...state,
        notes: set(
          state.notes,
          state.tab,
          editBuffer(state.notes[state.tab] ?? emptyBuffer, action),
        ),
      })
    }
    return keep(state)
  }

  const rows = q.options.length + 1
  const other = onOtherRow(state)

  switch (action.type) {
    case 'move':
      return keep({
        ...state,
        cursor: set(
          state.cursor,
          state.tab,
          ((((state.cursor[state.tab] ?? 0) + action.delta) % rows) + rows) % rows,
        ),
      })
    case 'escape': {
      // Esc in the Other input only closes it; Esc elsewhere dismisses the dialog
      if (other && (state.other[state.tab]?.text ?? '') !== '') {
        return keep({ ...state, cursor: set(state.cursor, state.tab, 0) })
      }
      return { state, submit: false, dismiss: true }
    }
    case 'space':
      if (other) return keep(editStep(state, { type: 'text', input: ' ' }))
      return keep(choose(state, state.cursor[state.tab] ?? 0))
    case 'number':
      if (other) return keep(editStep(state, { type: 'text', input: String(action.n) }))
      return keep(choose(state, action.n - 1))
    case 'notes':
      if (other) return keep(editStep(state, { type: 'text', input: 'n' }))
      return keep({ ...state, notesOpen: true })
    case 'enter': {
      if (other) {
        if ((state.other[state.tab]?.text.trim() ?? '') === '') return keep(state)
        return nextOrSubmit(state)
      }
      const at = state.cursor[state.tab] ?? 0
      if (q.multiSelect) return nextOrSubmit(state)
      return nextOrSubmit(choose(state, at))
    }
    case 'text':
    case 'edit':
      if (!other) return keep(state)
      return keep(editStep(state, action))
  }
}

/** Edit the Other text; in radio mode typing replaces the chosen option. */
function editStep(state: QuestionState, action: QuestionAction): QuestionState {
  const q = state.questions[state.tab]
  const buffer = editBuffer(state.other[state.tab] ?? emptyBuffer, action)
  return {
    ...state,
    warn: false,
    other: set(state.other, state.tab, buffer),
    picked:
      q && !q.multiSelect && buffer.text !== '' ? set(state.picked, state.tab, []) : state.picked,
  }
}
