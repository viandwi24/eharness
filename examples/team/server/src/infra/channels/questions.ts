/**
 * Questions (`ask_user_question`) asked in a chat, answered in the chat (docs/plans/P41-team-channels.md,
 * L6 notes). Pure helpers: how a question reads in a message, how a reply maps to answers and how
 * the answered message reads. The gateway decides who may answer and when.
 */
import type { Answer, Question } from 'eharness/ask'

/** Text of one option line: `1. label - description`. */
const optionLine = (o: Question['options'][number], i: number): string =>
  `${i + 1}. ${o.label}${o.description !== undefined && o.description.trim() !== '' ? ` - ${o.description.trim()}` : ''}`

/** Options that can be tapped: a single question that picks exactly one option. */
export const tappable = (questions: readonly Question[]): boolean =>
  questions.length === 1 && questions[0]?.multiSelect === false

/**
 * The announcement. Never a link: a chat message answers it (a tap when the platform has buttons).
 * `webLink` is only given when the web app is reachable from outside (not loopback).
 */
export function renderQuestions(
  questions: readonly Question[],
  opts: { buttons: boolean; webLink?: string | undefined },
): string {
  const lines: string[] = []
  const many = questions.length > 1
  lines.push(
    many
      ? `I have ${questions.length} questions for you.`
      : questions[0] === undefined
        ? 'I have a question for you.'
        : 'I have a question for you:',
  )
  questions.forEach((q, qi) => {
    lines.push(many ? `\nQuestion ${qi + 1} of ${questions.length}: ${q.question}` : q.question)
    for (const [i, o] of q.options.entries()) lines.push(optionLine(o, i))
    if (q.multiSelect) lines.push('(you may pick several)')
  })
  lines.push('')
  if (many) {
    lines.push(
      'Reply with the answer to question 1 (then the next), or answer all in one message with one line per question. Type a number, an option, or your own words.',
    )
  } else if (opts.buttons && tappable(questions)) {
    lines.push('Tap an option, or reply with your own answer.')
  } else {
    lines.push('Reply with a number, an option, or your own answer.')
  }
  if (opts.webLink !== undefined) lines.push(`You can also answer in ${opts.webLink}`)
  return lines.join('\n')
}

const norm = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, '')

/** An option named by its number or its label (case and trailing punctuation ignored). */
function optionOf(q: Question, part: string): string | undefined {
  const t = norm(part)
  if (/^\d+$/.test(t)) {
    const n = Number(t)
    if (n >= 1 && n <= q.options.length) return q.options[n - 1]?.label
  }
  return q.options.find((o) => norm(o.label) === t)?.label
}

/** One reply as the answer to one question: options when it names them, otherwise "Other" text. */
export function answerFromText(q: Question, text: string): Answer {
  const body = text.trim()
  if (q.multiSelect) {
    const parts = body
      .split(/\s*(?:,|;|\band\b|&|\n)\s*/i)
      .map((p) => p.trim())
      .filter((p) => p !== '')
    const labels = parts.map((p) => optionOf(q, p))
    if (parts.length > 0 && labels.every((l) => l !== undefined)) {
      return { selected: [...new Set(labels as string[])] }
    }
    return { other: body }
  }
  const one = optionOf(q, body)
  return one === undefined ? { other: body } : { selected: [one] }
}

/** The answer of a button: option `index` of a question. */
export function answerFromOption(q: Question, index: number): Answer | undefined {
  const label = q.options[index]?.label
  return label === undefined ? undefined : { selected: [label] }
}

/**
 * One message that answers all the remaining questions: as many non-empty lines as questions
 * (a leading `1.` or `1)` is dropped). Undefined when it does not look like that.
 */
export function answersFromLines(
  remaining: readonly Question[],
  text: string,
): Answer[] | undefined {
  if (remaining.length < 2) return undefined
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
  if (lines.length !== remaining.length) return undefined
  return remaining.map((q, i) =>
    answerFromText(q, (lines[i] as string).replace(/^\s*(?:q?\d+\s*[.):-])\s*/i, '')),
  )
}

/** The answered message: `Answered: beta` (several questions: joined with `; `). */
export function summarizeAnswers(
  questions: readonly Question[],
  answers: readonly Answer[],
): string {
  const parts = questions.map((_, i) => {
    const a = answers[i]
    const bits = [...(a?.selected ?? []), ...(a?.other?.trim() ? [`"${a.other.trim()}"`] : [])]
    return bits.length === 0 ? '(no answer)' : bits.join(', ')
  })
  return parts.join('; ')
}
