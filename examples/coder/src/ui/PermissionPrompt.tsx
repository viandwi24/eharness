import { Box, Text, useInput } from 'ink'
import { type ReactElement, useEffect, useState } from 'react'
import {
  type ApprovalAnswer,
  type ApprovalBroker,
  type ApprovalRequest,
  TOOL,
} from '../contracts.ts'
import { DiffView } from './DiffView.tsx'
import { type Buffer, backspace, deleteForward, emptyBuffer, insert, move } from './editor.ts'
import { keyedLines } from './keys.ts'
import { stripControl } from './sanitize.ts'
import { color, sym } from './theme.ts'
import { displayPath } from './tool-summary.ts'

/** One selectable answer. */
export interface PromptOption {
  label: string
  answer: ApprovalAnswer | 'feedback'
}

/** The options for a request; "don't ask again" entries only when a rule is offered. */
export function optionsFor(request: ApprovalRequest): PromptOption[] {
  const options: PromptOption[] = [{ label: 'Yes', answer: { approved: true } }]
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
  options.push({ label: 'No, and tell coder what to do differently (esc)', answer: 'feedback' })
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
      return 'Plan'
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

function Detail({ request }: { request: ApprovalRequest }): ReactElement | null {
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

/** Shows the first pending request of the broker and answers it. */
export function PermissionPrompt({ broker }: { broker: ApprovalBroker }): ReactElement | null {
  const pending = usePending(broker)
  const request = pending[0]
  const [index, setIndex] = useState(0)
  const [feedback, setFeedback] = useState<Buffer | null>(null)
  const requestId = request?.id

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the selection per request
  useEffect(() => {
    setIndex(0)
    setFeedback(null)
  }, [requestId])

  const options = request ? optionsFor(request) : []

  const choose = (option: PromptOption | undefined): void => {
    if (!request || !option) return
    if (option.answer === 'feedback') {
      setFeedback(emptyBuffer)
      return
    }
    broker.answer(request.id, option.answer)
  }

  useInput(
    (input, key) => {
      if (!request) return
      if (feedback) {
        if (key.escape) setFeedback(null)
        else if (key.return) {
          const text = feedback.text.trim()
          broker.answer(
            request.id,
            text ? { approved: false, feedback: text } : { approved: false },
          )
        } else if (key.leftArrow) setFeedback(move(feedback, -1))
        else if (key.rightArrow) setFeedback(move(feedback, 1))
        else if (key.backspace) setFeedback(backspace(feedback))
        else if (key.delete) setFeedback(deleteForward(feedback))
        else if (input && !key.ctrl && !key.meta && !key.tab) {
          setFeedback(insert(feedback, input.replace(/[\r\n]+/g, ' ')))
        }
        return
      }
      if (key.escape) {
        broker.answer(request.id, { approved: false })
      } else if (key.upArrow) setIndex((i) => (i + options.length - 1) % options.length)
      else if (key.downArrow || (key.tab && !key.shift)) setIndex((i) => (i + 1) % options.length)
      else if (key.return) choose(options[index])
      else if (/^[1-9]$/.test(input) && Number(input) <= options.length) {
        choose(options[Number(input) - 1])
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
      {feedback ? (
        <Box>
          <Text color={color.accent}>Tell coder what to do differently: </Text>
          <Text>{feedback.text.slice(0, feedback.cursor)}</Text>
          <Text inverse>{feedback.text[feedback.cursor] ?? ' '}</Text>
          <Text>{feedback.text.slice(feedback.cursor + 1)}</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {options.map((option, i) => (
            <Text key={option.label} color={i === index ? color.accent : undefined}>
              {i === index ? sym.pointer : ' '} {i + 1}. {option.label}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  )
}
