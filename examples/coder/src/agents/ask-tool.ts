/**
 * `ask_user_question`: multiple-choice questions for the user. A client tool (no `execute`): the
 * turn stops `tool-pending` and {@link driveTurn} answers it through the broker.
 */
import { tool } from 'ai'
import { z } from 'zod'
import { type Question, type QuestionRequest, type QuestionResult, TOOL } from '../contracts.ts'

const ASK_DESCRIPTION =
  'Ask the user one to four multiple-choice questions to gather requirements, learn their ' +
  'preferences or resolve an ambiguity that changes the result. Each question has 2 to 4 ' +
  'options (a short label and an optional description) and is either single choice or ' +
  '`multiSelect`. The user can always pick "Other" and type their own answer, and can add notes, ' +
  'so do not add an "Other" option yourself. Put the option you recommend first. The answers come ' +
  'back as the tool result. Do not use this tool to ask for approval of an action (the ' +
  'permission system does that) or to ask whether your plan is ready (call exit_plan_mode).'

const questionSchema = z.object({
  question: z.string().min(1).describe('The full question, ending with a question mark'),
  header: z.string().min(1).max(12).describe('A very short label for the question (max 12 chars)'),
  options: z
    .array(
      z.object({
        label: z.string().min(1).describe('Short choice text (1 to 5 words)'),
        description: z.string().optional().describe('What this choice means or implies'),
      }),
    )
    .min(2)
    .max(4),
  multiSelect: z.boolean().describe('Allow selecting several options instead of exactly one'),
})

const inputSchema = z.object({ questions: z.array(questionSchema).min(1).max(4) })

/** The client tool the model calls to ask the user (main agent only). */
export function createAskTool(): ReturnType<typeof tool> {
  return tool({ description: ASK_DESCRIPTION, inputSchema }) as ReturnType<typeof tool>
}

/** Validate a call's input; `error` is text the model can read and correct itself from. */
export function parseQuestions(input: unknown): { questions: Question[] } | { error: string } {
  const parsed = inputSchema.safeParse(input)
  if (parsed.success) return { questions: parsed.data.questions as Question[] }
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
    .join('; ')
  return { error: `Invalid ${TOOL.ask} input: ${issues}` }
}

/** Build the broker request of one call. */
export function questionRequest(
  toolCallId: string,
  questions: Question[],
  agent?: string,
): QuestionRequest {
  return { id: toolCallId, ...(agent !== undefined ? { agent } : {}), questions }
}

/** The text the model reads as the tool result. */
export function formatAnswers(request: QuestionRequest, result: QuestionResult): string {
  if (result === null) {
    return 'The user dismissed the questions without answering. Proceed with your best judgment or ask in plain text.'
  }
  const lines = ['The user answered:']
  request.questions.forEach((q, index) => {
    const answer = result.answers[index]
    const parts: string[] = []
    const selected = answer?.selected ?? []
    if (selected.length > 0) parts.push(selected.join(', '))
    const other = answer?.other?.trim()
    if (other) parts.push(`other: "${other}"`)
    lines.push(`- ${q.header}: ${parts.length > 0 ? parts.join('; ') : '(no answer)'}`)
    const notes = answer?.notes?.trim()
    if (notes) lines.push(`  notes: ${notes}`)
  })
  return lines.join('\n')
}
