import { Box, Text, useInput } from 'ink'
import { type ReactElement, useEffect, useState } from 'react'
import type { ApprovalAnswer, ApprovalBroker, ApprovalRequest } from '../contracts.ts'
import { DiffView } from './DiffView.tsx'
import { type Buffer, backspace, deleteForward, emptyBuffer, insert, move } from './editor.ts'
import { keyedLines } from './keys.ts'
import { stripControl } from './sanitize.ts'
import { color, sym } from './theme.ts'

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
      label: `Yes, and don't ask again for ${stripControl(request.suggestedRule)} (this session)`,
      answer: { approved: true, remember: 'session' },
    })
    options.push({
      label: 'Yes, always for this project',
      answer: { approved: true, remember: 'project' },
    })
  }
  options.push({ label: 'No, and tell the agent what to do instead', answer: 'feedback' })
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

function Detail({ request }: { request: ApprovalRequest }): ReactElement | null {
  if (!request.detail) return null
  const detail = stripControl(request.detail)
  if (/^(--- |@@ |Index: )/m.test(detail)) {
    return <DiffView patch={detail} maxLines={20} />
  }
  const lines = detail.split('\n')
  return (
    <Box flexDirection="column">
      {keyedLines(lines.slice(0, 20)).map(({ key, line }) => (
        <Text key={key} dimColor>
          {line === '' ? ' ' : line}
        </Text>
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
  const who = request.agent ? `${stripControl(request.agent)} wants to` : 'The agent wants to'
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color.running}
      paddingX={1}
      marginTop={1}
    >
      <Text>
        <Text color={color.running} bold>
          {who}:{' '}
        </Text>
        <Text bold>{stripControl(request.title).replace(/\s*\n\s*/g, ' ')}</Text>
        {pending.length > 1 ? <Text dimColor> (+{pending.length - 1} more)</Text> : null}
      </Text>
      <Detail request={request} />
      {feedback ? (
        <Box marginTop={1}>
          <Text color={color.accent}>Tell the agent what to do instead: </Text>
          <Text>{feedback.text.slice(0, feedback.cursor)}</Text>
          <Text inverse>{feedback.text[feedback.cursor] ?? ' '}</Text>
          <Text>{feedback.text.slice(feedback.cursor + 1)}</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {options.map((option, i) => (
            <Text key={option.label} color={i === index ? color.accent : undefined}>
              {i === index ? sym.pointer : ' '} {i + 1}. {option.label}
            </Text>
          ))}
          <Text dimColor>↑/↓ and enter, or press a number · esc to deny</Text>
        </Box>
      )}
    </Box>
  )
}
