import { Box, Text, useInput } from 'ink'
import { type ReactElement, useEffect, useRef, useState } from 'react'
import type { ApprovalBroker, QuestionRequest } from '../contracts.ts'
import type { Buffer } from './editor.ts'
import {
  answerText,
  buildAnswer,
  hasSubmitTab,
  initialQuestionState,
  isAnswered,
  onOtherRow,
  onSubmitTab,
  type QuestionAction,
  type QuestionState,
  questionReduce,
  unanswered,
} from './question-state.ts'
import { stripControl } from './sanitize.ts'
import { color, sym } from './theme.ts'

/** Hook: the broker's pending questions (re-read on every broker change). */
export function usePendingQuestions(broker: ApprovalBroker): QuestionRequest[] {
  const [pending, setPending] = useState<QuestionRequest[]>(() => broker.pendingQuestions())
  useEffect(() => {
    setPending(broker.pendingQuestions())
    return broker.subscribe(() => setPending(broker.pendingQuestions()))
  }, [broker])
  return pending
}

/** A text input with a visible cursor. */
function Input({ buffer }: { buffer: Buffer }): ReactElement {
  return (
    <Text>
      {buffer.text.slice(0, buffer.cursor)}
      <Text inverse>{buffer.text[buffer.cursor] ?? ' '}</Text>
      {buffer.text.slice(buffer.cursor + 1)}
    </Text>
  )
}

function Tabs({ state }: { state: QuestionState }): ReactElement {
  return (
    <Box>
      {state.questions.map((q, i) => (
        <Text key={q.header + String(i)} inverse={state.tab === i} color={color.accent}>
          {' '}
          {isAnswered(state, i) ? '☒' : '☐'} {stripControl(q.header)}{' '}
        </Text>
      ))}
      {hasSubmitTab(state) ? (
        <Text inverse={onSubmitTab(state)} color={color.accent}>
          {' '}
          ✔ Submit{' '}
        </Text>
      ) : null}
    </Box>
  )
}

function QuestionBody({ state }: { state: QuestionState }): ReactElement | null {
  const i = state.tab
  const q = state.questions[i]
  if (!q) return null
  const cursor = state.cursor[i] ?? 0
  const picked = state.picked[i] ?? []
  const other = state.other[i] ?? { text: '', cursor: 0 }
  const notes = state.notes[i] ?? { text: '', cursor: 0 }
  const otherFocused = onOtherRow(state)
  const mark = (on: boolean): string => (q.multiSelect ? (on ? '[✔]' : '[ ]') : on ? '(•)' : '( )')
  return (
    <Box flexDirection="column">
      <Text bold>{stripControl(q.question)}</Text>
      <Box flexDirection="column" marginTop={1}>
        {q.options.map((option, n) => (
          <Box key={option.label} flexDirection="column">
            <Text color={cursor === n ? color.accent : undefined}>
              {cursor === n ? sym.pointer : ' '} {n + 1}. {mark(picked.includes(n))}{' '}
              {stripControl(option.label)}
            </Text>
            {option.description ? (
              <Text dimColor>
                {'         '}
                {stripControl(option.description)}
              </Text>
            ) : null}
          </Box>
        ))}
        <Box>
          <Text color={otherFocused ? color.accent : undefined}>
            {otherFocused ? sym.pointer : ' '} {q.options.length + 1}.{' '}
            {mark(other.text.trim() !== '')}{' '}
          </Text>
          {otherFocused ? (
            other.text === '' ? (
              <Text>
                <Text inverse> </Text>
                <Text dimColor>Other: type your answer</Text>
              </Text>
            ) : (
              <Input buffer={other} />
            )
          ) : (
            <Text color={other.text === '' ? undefined : color.accent} dimColor={other.text === ''}>
              {other.text === '' ? 'Other: type your answer' : other.text}
            </Text>
          )}
        </Box>
      </Box>
      <Box marginTop={1}>
        {state.notesOpen ? (
          <Text>
            <Text color={color.accent}>Notes: </Text>
            <Input buffer={notes} />
          </Text>
        ) : notes.text !== '' ? (
          <Text dimColor>Notes: {notes.text} (n to edit)</Text>
        ) : (
          <Text dimColor>n to add notes</Text>
        )}
      </Box>
    </Box>
  )
}

function Review({ state }: { state: QuestionState }): ReactElement {
  const missing = unanswered(state)
  return (
    <Box flexDirection="column">
      <Text bold>Review your answers</Text>
      <Box flexDirection="column" marginTop={1}>
        {state.questions.map((q, i) => {
          const text = answerText(state, i)
          const notes = state.notes[i]?.text.trim() ?? ''
          return (
            <Box key={q.header + String(i)} flexDirection="column">
              <Text>
                <Text color={color.accent}>{stripControl(q.header)}</Text>
                {' → '}
                {text === '' ? <Text dimColor>(no answer)</Text> : text}
              </Text>
              {notes ? <Text dimColor> Notes: {notes}</Text> : null}
            </Box>
          )
        })}
      </Box>
      {state.warn && missing.length > 0 ? (
        <Box marginTop={1}>
          <Text color={color.warning}>Answer every question first</Text>
        </Box>
      ) : null}
    </Box>
  )
}

/** Footer hint of the active tab. */
export function questionHint(state: QuestionState): string {
  if (state.notesOpen) return 'Enter to save notes · Esc to close'
  if (onSubmitTab(state)) return 'Enter to submit · ←/→ to switch · Esc to cancel'
  const multi = hasSubmitTab(state)
  const q = state.questions[state.tab]
  const pick = q?.multiSelect ? 'Space to toggle' : 'Enter to select'
  if (onOtherRow(state)) return 'Type your answer · Enter to confirm · Esc to close the input'
  return `${pick} · ↑/↓ to move${multi ? ' · ←/→ to switch' : ''} · Esc to cancel`
}

/** The question of the first pending request, with one tab per question. */
export function QuestionDialog({ broker }: { broker: ApprovalBroker }): ReactElement | null {
  const pending = usePendingQuestions(broker)
  const request = pending[0]
  const requestId = request?.id
  const [state, setState] = useState<QuestionState | null>(() =>
    request ? initialQuestionState(request.questions) : null,
  )
  const ref = useRef(state)
  ref.current = state

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the state per request
  useEffect(() => {
    const next = request ? initialQuestionState(request.questions) : null
    ref.current = next
    setState(next)
  }, [requestId])

  const apply = (action: QuestionAction): void => {
    const current = ref.current
    if (!request || !current) return
    const step = questionReduce(current, action)
    ref.current = step.state
    setState(step.state)
    if (step.dismiss) broker.answerQuestion(request.id, null)
    else if (step.submit) broker.answerQuestion(request.id, buildAnswer(step.state))
  }

  useInput(
    (input, key) => {
      const current = ref.current
      if (!current) return
      if (key.escape) apply({ type: 'escape' })
      else if (key.tab) apply({ type: 'tab', delta: key.shift ? -1 : 1 })
      else if (key.return) apply({ type: 'enter' })
      else if (key.upArrow) apply({ type: 'move', delta: -1 })
      else if (key.downArrow) apply({ type: 'move', delta: 1 })
      else if (key.leftArrow) {
        if (current.notesOpen || onOtherRow(current)) apply({ type: 'edit', op: 'left' })
        else apply({ type: 'tab', delta: -1 })
      } else if (key.rightArrow) {
        if (current.notesOpen || onOtherRow(current)) apply({ type: 'edit', op: 'right' })
        else apply({ type: 'tab', delta: 1 })
      } else if (key.backspace) apply({ type: 'edit', op: 'backspace' })
      else if (key.delete) apply({ type: 'edit', op: 'delete' })
      else if (key.ctrl || key.meta || !input) return
      else if (current.notesOpen) apply({ type: 'text', input })
      else if (input === ' ') apply({ type: 'space' })
      else if (/^[1-9]$/.test(input)) apply({ type: 'number', n: Number(input) })
      else if (input === 'n') apply({ type: 'notes' })
      else apply({ type: 'text', input })
    },
    { isActive: request !== undefined },
  )

  if (!request || !state) return null
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color.accent}
      paddingX={1}
      marginTop={1}
    >
      <Box>
        <Tabs state={state} />
        {request.agent ? <Text dimColor> (from {stripControl(request.agent)})</Text> : null}
        {pending.length > 1 ? <Text dimColor> (+{pending.length - 1} more)</Text> : null}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {onSubmitTab(state) ? <Review state={state} /> : <QuestionBody state={state} />}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{questionHint(state)}</Text>
      </Box>
    </Box>
  )
}
