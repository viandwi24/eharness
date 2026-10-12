/**
 * Remembered decisions of a standing program (P40 value pass). A standing program that escalates
 * the same situation every run ("T-05 is blocked") is noise once the client answered "keep
 * waiting". An answer of that kind is remembered per program and subject with an expiry, and later
 * runs are told about it so they do not escalate it again. Pure.
 */

export interface RememberedDecision {
  id: string
  programId: string
  /** What it is about: a record id in the title (`T-05`), else the normalised title. */
  subject: string
  /** The question as asked. */
  question: string
  /** The option the client picked. */
  choice: string
  note: string
  decisionId: string
  decidedAt: number
  expiresAt: number
}

export const MEMORY_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const MAX_REMEMBERED = 50

/** Choices that say "leave it as it is for now": wait, skip, ignore, later, snooze. */
const STAND_DOWN =
  /\b(keep\s+waiting|wait|hold|skip|ignore|dismiss|snooze|not\s+now|later|no\s+action|leave\s+(it|as)|do\s+nothing|don'?t\s+(escalate|ask)|continue\s+waiting)\b/i

export const isStandDownChoice = (choice: string): boolean => STAND_DOWN.test(choice)

const RECORD_ID = /\b[A-Za-z]{1,6}-\d{1,6}\b/g

/** The subject of an escalation: the record ids in its title, else the title without noise. */
export function subjectOf(title: string, question = ''): string {
  const ids = [
    ...new Set((`${title} ${question}`.match(RECORD_ID) ?? []).map((i) => i.toUpperCase())),
  ]
  if (ids.length > 0) return ids.sort().slice(0, 3).join(',')
  return title
    .toLowerCase()
    .replace(/\d{4}-\d{2}-\d{2}/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

export const activeMemory = (
  items: readonly RememberedDecision[],
  now: number,
): RememberedDecision[] => items.filter((m) => m.expiresAt > now)

/** The section of the run prompt that tells the run what the client already settled. */
export function memoryPromptSection(items: readonly RememberedDecision[], now: number): string[] {
  const active = activeMemory(items, now)
  if (active.length === 0) return []
  return [
    '## Decisions the client already made (do not ask these again)',
    ...active.map(
      (m) =>
        `- ${m.subject}: "${m.choice}"${m.note === '' ? '' : ` (${m.note})`}, decided ${new Date(m.decidedAt).toISOString().slice(0, 10)}, valid until ${new Date(m.expiresAt).toISOString().slice(0, 10)}. Mention it in your report if relevant, but do not call escalate for it unless the situation clearly changed.`,
    ),
    '',
  ]
}
