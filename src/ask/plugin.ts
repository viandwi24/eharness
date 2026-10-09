/**
 * The `askUser()` plugin (spec 21): `ask_user_question`, a multiple-choice question tool.
 *
 * Built only with the public core API (ADR-0008). Interactive profile: a client tool (no
 * `execute`), the turn stops `tool-pending` and the app answers with `respond({ toolOutputs })`.
 * Non-interactive profile: the tool executes and returns the `whenNoHuman` fallback.
 *
 * @see docs/specs/21-ask-plugin.md
 */

import { tool } from 'ai'
import { z } from 'zod/v4'
import {
  definePlugin,
  type HarnessContext,
  type HarnessPlugin,
  type PendingState,
} from '../index.ts'

/** Default tool name. */
export const ASK_TOOL = 'ask_user_question'

/** Model-facing description of the tool (changing it is a minor change). */
export const ASK_DESCRIPTION: string =
  'Ask the user one to four multiple-choice questions to gather requirements, learn their ' +
  'preferences or resolve an ambiguity that changes the result. Each question has 2 to 4 ' +
  'options (a short label and an optional description) and is either single choice or ' +
  '`multiSelect`. The user can always pick "Other" and type their own answer, and can add notes, ' +
  'so do not add an "Other" option yourself. Put the option you recommend first. The answers come ' +
  'back as the tool result. Do not use this tool to ask for approval of an action (the ' +
  'permission system does that) or to ask whether your plan is ready.'

/** One option of a question. */
export interface QuestionOption {
  label: string
  description?: string
}

/** One multiple-choice question. */
export interface Question {
  question: string
  /** At most 12 characters. */
  header: string
  options: QuestionOption[]
  multiSelect: boolean
}

/** The answer to one question: the selected labels, a free-text "Other" and notes. */
export interface Answer {
  selected?: string[]
  other?: string
  notes?: string
}

/** The user's answers (one per question, same order) or `null` when the questions were dismissed. */
export type QuestionResult = { answers: Answer[] } | null

/** Options of {@link askUser}. */
export interface AskUserOptions {
  /** Default `'ask_user_question'`. */
  toolName?: string
  /** Default 4 (the schema allows 1 to `maxQuestions`, at most 4). */
  maxQuestions?: number
  /**
   * Whether a human can answer. `false` makes the tool execute and return the `whenNoHuman`
   * fallback. A function is evaluated once per session at tool resolution. Default `true`.
   */
  interactive?: boolean | ((ctx: HarnessContext) => boolean)
  /**
   * Fallback when not interactive: `'dismiss'` (default) answers as if the user dismissed the
   * questions, `'error'` returns an `ERROR:` text, a function returns the answers (or `null`).
   */
  whenNoHuman?:
    | 'dismiss'
    | 'error'
    | ((questions: Question[]) => QuestionResult | Promise<QuestionResult>)
}

const DISMISSED =
  'The user dismissed the questions without answering. Proceed with your best judgment or ask in plain text.'

function questionsSchema(max: number): z.ZodType<{ questions: Question[] }> {
  const q = z.object({
    question: z.string().min(1).describe('The full question, ending with a question mark'),
    header: z
      .string()
      .min(1)
      .max(12)
      .describe('A very short label for the question (max 12 chars)'),
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
  return z.object({ questions: z.array(q).min(1).max(max) }) as unknown as z.ZodType<{
    questions: Question[]
  }>
}

/** Validate a call's input; `error` is text the model can read and correct itself from. */
export function parseQuestions(
  input: unknown,
  opts: { toolName?: string; maxQuestions?: number } = {},
): { questions: Question[] } | { error: string } {
  const parsed = questionsSchema(clampMax(opts.maxQuestions)).safeParse(input)
  if (parsed.success) return { questions: parsed.data.questions }
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
    .join('; ')
  return { error: `Invalid ${opts.toolName ?? ASK_TOOL} input: ${issues}` }
}

function clampMax(max: number | undefined): number {
  return Math.min(4, Math.max(1, Math.floor(max ?? 4)))
}

/** The text the model reads as the tool result. */
export function formatAnswers(questions: readonly Question[], result: QuestionResult): string {
  if (result === null) return DISMISSED
  const lines = ['The user answered:']
  questions.forEach((q, index) => {
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

/** A pending question call: the parsed questions, or the `error` the model gets back. */
export type PendingQuestion =
  | { toolCallId: string; questions: Question[]; error?: undefined }
  | { toolCallId: string; error: string; questions?: undefined }

/**
 * Question calls of a pending state (`PendingState.clientTools`). The pending state carries the
 * call input; when it was too large to copy (`inputTruncated`) pass the stored input in
 * `storedInputs` (by `toolCallId`, from the stored message part), otherwise that call is an error.
 */
export function pendingQuestions(
  pending: PendingState | null | undefined,
  opts: { toolName?: string; maxQuestions?: number; storedInputs?: Record<string, unknown> } = {},
): PendingQuestion[] {
  const name = opts.toolName ?? ASK_TOOL
  const out: PendingQuestion[] = []
  for (const call of pending?.clientTools ?? []) {
    if (call.toolName !== name) continue
    let input: unknown = call.input
    if (call.inputTruncated) input = opts.storedInputs?.[call.toolCallId]
    if (input === undefined) {
      out.push({ toolCallId: call.toolCallId, error: `The ${name} input is not available` })
      continue
    }
    const parsed = parseQuestions(input, { toolName: name, maxQuestions: opts.maxQuestions })
    out.push(
      'error' in parsed
        ? { toolCallId: call.toolCallId, error: parsed.error }
        : { toolCallId: call.toolCallId, questions: parsed.questions },
    )
  }
  return out
}

/**
 * The `toolOutputs` entry of `respond()` for one question call. `result` `null` is a dismissal;
 * an invalid call answers with its error. `note` is appended (for example a timeout note).
 */
export function answerOutput(
  call: PendingQuestion,
  result: QuestionResult,
  note?: string,
): { toolCallId: string; output: string } | { toolCallId: string; errorText: string } {
  if (call.error !== undefined) return { toolCallId: call.toolCallId, errorText: call.error }
  const text = formatAnswers(call.questions, result)
  return { toolCallId: call.toolCallId, output: note ? `${text}\n\n${note}` : text }
}

/** The ask plugin. @see docs/specs/21-ask-plugin.md */
export function askUser(options: AskUserOptions = {}): HarnessPlugin<'ask'> {
  const toolName = options.toolName ?? ASK_TOOL
  const max = clampMax(options.maxQuestions)
  const whenNoHuman = options.whenNoHuman ?? 'dismiss'
  return definePlugin({
    name: 'ask',
    session(ctx) {
      const interactive =
        typeof options.interactive === 'function'
          ? options.interactive(ctx as HarnessContext)
          : (options.interactive ?? true)
      const inputSchema = questionsSchema(max)
      const base = { description: ASK_DESCRIPTION, inputSchema }
      if (interactive) return { tools: { [toolName]: tool(base) } }
      return {
        tools: {
          [toolName]: tool({
            ...base,
            execute: async ({ questions }): Promise<string> => {
              if (whenNoHuman === 'error') {
                return 'ERROR: no user is available to answer questions. Decide yourself and state your assumption.'
              }
              if (whenNoHuman === 'dismiss') return formatAnswers(questions, null)
              try {
                return formatAnswers(questions, await whenNoHuman(questions))
              } catch (error) {
                return `ERROR: ${error instanceof Error ? error.message : String(error)}`
              }
            },
          }),
        },
      }
    },
  })
}
