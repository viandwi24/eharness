import { Box, type Key, Text, useInput } from 'ink'
import { type ReactElement, useEffect, useState } from 'react'
import {
  type ApprovalAnswer,
  type ApprovalBroker,
  type ApprovalRequest,
  TOOL,
} from '../contracts.ts'
import { DiffView } from './DiffView.tsx'
import { type Buffer, backspace, deleteForward, insert, move } from './editor.ts'
import { keyedLines } from './keys.ts'
import { Markdown } from './markdown.tsx'
import { stripControl } from './sanitize.ts'
import { color, sym } from './theme.ts'
import { displayPath } from './tool-summary.ts'

/** One selectable answer. */
export interface PromptOption {
  label: string
  answer: ApprovalAnswer
  /** Tab opens a comment field on this option: a note (Yes) or the denial feedback (No). */
  comment?: 'note' | 'feedback'
}

/** The answer of an option with the user's comment applied (empty comment: none). */
export function answerWith(option: PromptOption, comment: string): ApprovalAnswer {
  const text = comment.trim()
  if (!text || !option.comment) return option.answer
  return option.answer.approved
    ? { ...option.answer, note: text }
    : { approved: false, feedback: text }
}

/** The options for a request; "don't ask again" entries only when a rule is offered. */
export function optionsFor(request: ApprovalRequest): PromptOption[] {
  if (request.toolName === TOOL.exitPlan) {
    return [
      {
        label: 'Yes, and auto-accept edits',
        answer: { approved: true, mode: 'acceptEdits' },
        comment: 'note',
      },
      {
        label: 'Yes, and manually approve edits',
        answer: { approved: true, mode: 'default' },
        comment: 'note',
      },
      { label: 'No, keep planning', answer: { approved: false }, comment: 'feedback' },
    ]
  }
  const options: PromptOption[] = [{ label: 'Yes', answer: { approved: true }, comment: 'note' }]
  if (request.suggestedRule) {
    options.push({
      label: `Yes, and don't ask again for ${stripControl(request.suggestedRule)}`,
      answer: { approved: true, remember: 'session' },
    })
    options.push({
      label: 'Yes, always for this project',
      answer: { approved: true, remember: 'project' },
    })
  }
  options.push({
    label: 'No, and tell coder what to do differently (esc)',
    answer: { approved: false },
    comment: 'feedback',
  })
  return options
}

/** Hook: the broker's pending requests. */
export function usePending(broker: ApprovalBroker): ApprovalRequest[] {
  const [pending, setPending] = useState<ApprovalRequest[]>(() => broker.pending())
  useEffect(() => {
    setPending(broker.pending())
    return broker.subscribe(setPending)
  }, [broker])
  return pending
}

/** Dialog title of a tool call. */
export function dialogTitle(toolName: string): string {
  switch (toolName) {
    case TOOL.bash:
      return 'Bash command'
    case TOOL.edit:
      return 'Edit file'
    case TOOL.write:
      return 'Create file'
    case TOOL.delete:
      return 'Delete file'
    case TOOL.agent:
      return 'Agent'
    case TOOL.exitPlan:
      return 'Ready to code?'
    case TOOL.dirAccess:
      return 'Directory access'
    default:
      return toolName
  }
}

/** The question above the options. */
export function dialogQuestion(request: ApprovalRequest): string {
  const path = (request.input as { path?: unknown } | null)?.path
  const file = typeof path === 'string' ? stripControl(displayPath(path)) : undefined
  switch (request.toolName) {
    case TOOL.exitPlan:
      return 'Would you like to proceed?'
    case TOOL.edit:
      return file ? `Do you want to make this edit to ${file}?` : 'Do you want to make this edit?'
    case TOOL.write:
      return file ? `Do you want to create ${file}?` : 'Do you want to create this file?'
    case TOOL.delete:
      return file ? `Do you want to delete ${file}?` : 'Do you want to delete this file?'
    default:
      return 'Do you want to proceed?'
  }
}

const PLAN_MAX_LINES = 60

function Detail({ request }: { request: ApprovalRequest }): ReactElement | null {
  if (request.toolName === TOOL.exitPlan) {
    const plan = stripControl(request.detail ?? '')
    if (!plan.trim()) return null
    const lines = plan.split('\n')
    return (
      <Box flexDirection="column">
        <Markdown text={lines.slice(0, PLAN_MAX_LINES).join('\n')} />
        {lines.length > PLAN_MAX_LINES ? (
          <Text dimColor>… {lines.length - PLAN_MAX_LINES} more lines</Text>
        ) : null}
      </Box>
    )
  }
  const command = (request.input as { command?: unknown } | null)?.command
  const raw = request.detail ?? (typeof command === 'string' ? command : undefined)
  if (!raw) return null
  const detail = stripControl(raw)
  if (/^(--- |@@ |Index: )/m.test(detail)) {
    return <DiffView patch={detail} maxLines={20} expandHint={false} />
  }
  const lines = detail.split('\n')
  return (
    <Box flexDirection="column">
      {keyedLines(lines.slice(0, 20)).map(({ key, line }) => (
        <Text key={key}>{line === '' ? ' ' : line}</Text>
      ))}
      {lines.length > 20 ? <Text dimColor>… {lines.length - 20} more lines</Text> : null}
    </Box>
  )
}

/** Pure key handling of the comment field; returns the next buffer. */
function editComment(buf: Buffer, input: string, key: Key): Buffer {
  if (key.leftArrow) return move(buf, -1)
  if (key.rightArrow) return move(buf, 1)
  if (key.backspace) return backspace(buf)
  if (key.delete) return deleteForward(buf)
  if (input && !key.ctrl && !key.meta && !key.tab)
    return insert(buf, input.replace(/[\r\n]+/g, ' '))
  return buf
}

/** Shows the first pending request of the broker and answers it. */
export function PermissionPrompt({ broker }: { broker: ApprovalBroker }): ReactElement | null {
  const pending = usePending(broker)
  const request = pending[0]
  const [index, setIndex] = useState(0)
  /** Comments kept per option index (Tab closes the field without dropping the text). */
  const [comments, setComments] = useState<Record<number, string>>({})
  /** The open comment field: option index and its buffer. */
  const [field, setField] = useState<{ index: number; buffer: Buffer } | null>(null)
  const requestId = request?.id

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the selection per request
  useEffect(() => {
    setIndex(0)
    setComments({})
    setField(null)
  }, [requestId])

  const options = request ? optionsFor(request) : []

  const choose = (i: number, comment = comments[i] ?? ''): void => {
    const option = options[i]
    if (!request || !option) return
    broker.answer(request.id, answerWith(option, comment))
  }

  useInput(
    (input, key) => {
      if (!request) return
      if (field) {
        if (key.escape || key.tab) {
          // close without answering, keep the text
          setComments((c) => ({ ...c, [field.index]: field.buffer.text }))
          setField(null)
        } else if (key.return) {
          choose(field.index, field.buffer.text)
        } else {
          setField({ ...field, buffer: editComment(field.buffer, input, key) })
        }
        return
      }
      if (key.escape) {
        broker.answer(request.id, { approved: false })
      } else if (key.upArrow) setIndex((i) => (i + options.length - 1) % options.length)
      else if (key.downArrow) setIndex((i) => (i + 1) % options.length)
      else if (key.tab) {
        if (!key.shift && options[index]?.comment) {
          const text = comments[index] ?? ''
          setField({ index, buffer: { text, cursor: text.length } })
        }
      } else if (key.return) choose(index)
      else if (/^[1-9]$/.test(input) && Number(input) <= options.length) {
        choose(Number(input) - 1)
      }
    },
    { isActive: request !== undefined },
  )

  if (!request) return null
  const heading = dialogTitle(request.toolName)
  const hasDetail =
    request.detail !== undefined ||
    typeof (request.input as { command?: unknown } | null)?.command === 'string'
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color.warning}
      paddingX={1}
      marginTop={1}
    >
      <Text>
        <Text color={color.warning} bold>
          {heading}
        </Text>
        {request.agent ? <Text dimColor> (from {stripControl(request.agent)})</Text> : null}
        {pending.length > 1 ? <Text dimColor> (+{pending.length - 1} more)</Text> : null}
      </Text>
      <Box flexDirection="column" marginTop={1} paddingLeft={2}>
        <Detail request={request} />
        <Text dimColor>
          {hasDetail ? '' : stripControl(request.title).replace(/\s*\n\s*/g, ' ')}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text bold>{dialogQuestion(request)}</Text>
      </Box>
      <Box flexDirection="column">
        {options.map((option, i) => {
          const comment = field?.index === i ? field.buffer : undefined
          const kept = comments[i]
          return (
            <Box key={option.label} flexDirection="column">
              <Text color={i === index ? color.accent : undefined}>
                {i === index ? sym.pointer : ' '} {i + 1}. {option.label}
              </Text>
              {comment ? (
                <Text>
                  {'     '}
                  <Text color={color.accent}>
                    {option.comment === 'note' ? 'Note: ' : 'Tell coder: '}
                  </Text>
                  {comment.text.slice(0, comment.cursor)}
                  <Text inverse>{comment.text[comment.cursor] ?? ' '}</Text>
                  {comment.text.slice(comment.cursor + 1)}
                </Text>
              ) : kept ? (
                <Text dimColor>
                  {'     '}
                  {option.comment === 'note' ? 'Note: ' : 'Feedback: '}
                  {kept}
                </Text>
              ) : null}
            </Box>
          )
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          {field
            ? 'Enter to send · Tab to close'
            : options[index]?.comment
              ? 'Tab to add a note · Esc to cancel'
              : 'Esc to cancel'}
        </Text>
      </Box>
    </Box>
  )
}
