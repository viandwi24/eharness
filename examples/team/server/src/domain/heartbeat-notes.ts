/**
 * Factual notes of the heartbeat (docs/plans/P52-context-and-orders.md). Pure.
 *
 * A note says what was seen, and the proof: at least one evidence reference (a chat with platform
 * message ids, a session with a message id, a URL or a library path) and how sure the beat is
 * (`seen` with its own eyes, or `inferred`). A note without evidence is refused with a sentence the
 * model can act on. Once a week the notes are condensed into confirmed patterns: only what has
 * evidence on at least two different days.
 */

export const NOTE_CONFIDENCE = ['seen', 'inferred'] as const
export type NoteConfidence = (typeof NOTE_CONFIDENCE)[number]

export const MIN_PATTERN_DAYS = 2

export interface NoteEvidenceInput {
  chat: string
  messageIds?: readonly string[] | undefined
  /** Other references: `https://...`, `/library/...`, `/memories/...`, `session:<id>#<message id>`. */
  evidence?: readonly string[] | undefined
  confidence?: string | undefined
}

const URL_REF = /^https?:\/\/\S+$/i
const LIBRARY_REF = /^\/library\/\S+$/
const MEMORY_REF = /^\/memories\/\S+$/
const SESSION_REF = /^session:([^\s#]+)#(\S+)$/

/** One evidence reference is well formed (a chat's message ids are checked with the chat). */
export const isEvidenceRef = (ref: string): boolean => {
  const r = ref.trim()
  return URL_REF.test(r) || LIBRARY_REF.test(r) || MEMORY_REF.test(r) || SESSION_REF.test(r)
}

export const EVIDENCE_HELP =
  'Give evidence: messageIds (platform message ids of the chat you name), or evidence with a URL, a /library/... or /memories/... path or session:<session id>#<message id>; and confidence "seen" (you read it yourself) or "inferred".'

/** undefined when the note may be written; else why not (a sentence for the model). */
export function checkNoteEvidence(input: NoteEvidenceInput): string | undefined {
  if (!(NOTE_CONFIDENCE as readonly string[]).includes(input.confidence ?? '')) {
    return `Not noted: say how sure you are: confidence "seen" or "inferred". ${EVIDENCE_HELP}`
  }
  const ids = (input.messageIds ?? []).filter((m) => m.trim() !== '')
  const refs = (input.evidence ?? []).map((e) => e.trim()).filter((e) => e !== '')
  const bad = refs.filter((r) => !isEvidenceRef(r))
  if (bad.length > 0) {
    return `Not noted: "${bad[0]}" is not an evidence reference. ${EVIDENCE_HELP}`
  }
  if (ids.length === 0 && refs.length === 0) {
    return `Not noted: a note needs at least one piece of evidence, or it is only a guess. ${EVIDENCE_HELP}`
  }
  return undefined
}

/** The proof part of a note line: `seen; ev: <ref>, <ref>`. */
export function evidenceTail(input: {
  confidence: string
  evidence?: readonly string[] | undefined
}): string {
  const refs = (input.evidence ?? [])
    .map((e) => e.trim().replace(/[),]/g, (c) => (c === ')' ? '%29' : '%2C')))
    .filter((e) => e !== '')
  return refs.length === 0
    ? input.confidence
    : `${input.confidence}; ev: ${refs.slice(0, 6).join(', ')}`
}

/** The references of one note line (library paths and sessions), to see whether they still resolve. */
export function refsOfNoteLine(line: string): { libraryPaths: string[]; sessions: string[] } {
  const libraryPaths = new Set<string>()
  const sessions = new Set<string>()
  const tail = /\(([a-z]+), (?:seen|inferred)(?:; ev: ([^)]*))?\)\s*$/.exec(line)
  for (const r of (tail?.[2] ?? '').split(',')) {
    const ref = r.trim()
    if (LIBRARY_REF.test(ref)) libraryPaths.add(ref)
    const s = SESSION_REF.exec(ref)
    if (s !== null) sessions.add(s[1] as string)
  }
  return { libraryPaths: [...libraryPaths], sessions: [...sessions] }
}

/**
 * The notes as a beat reads them: a line whose library path or session no longer exists says so, so
 * the beat does not build on something that is gone.
 */
export function markUnresolved(
  text: string,
  exists: { library: (path: string) => boolean; session: (id: string) => boolean },
): string {
  return text
    .split('\n')
    .map((line) => {
      const refs = refsOfNoteLine(line)
      const gone = [
        ...refs.libraryPaths.filter((p) => !exists.library(p)),
        ...refs.sessions.filter((s) => !exists.session(s)).map((s) => `session:${s}`),
      ]
      return gone.length === 0 ? line : `${line} [no longer resolves: ${gone.join(', ')}]`
    })
    .join('\n')
}

/** Where the confirmed patterns of an agent live. */
export const patternsPath = (agentSlug: string): string =>
  `/library/notes/heartbeat/${agentSlug}/patterns.md`

export const PATTERN_TOOL = 'heartbeat_pattern'
export const NOTES_TOOL = 'heartbeat_notes'
export const ORDER_DONE_TOOL = 'heartbeat_order_done'

/** `YYYY-MM-DD` days of a list that really have notes, distinct and sorted. */
export function patternDays(days: readonly string[], haveNotes: ReadonlySet<string>): string[] {
  return [...new Set(days.map((d) => d.trim()))].filter((d) => haveNotes.has(d)).sort()
}

/** undefined when the pattern may be written (evidence on at least two days); else why not. */
export function checkPattern(input: {
  pattern: string
  days: readonly string[]
  haveNotes: ReadonlySet<string>
}): string | undefined {
  if (input.pattern.trim() === '') return 'Not written: a pattern needs its text.'
  const days = patternDays(input.days, input.haveNotes)
  if (days.length < MIN_PATTERN_DAYS) {
    return `Not written: a confirmed pattern needs evidence on at least ${MIN_PATTERN_DAYS} different days (${days.length} of the days you named have notes). Keep it as a note until it repeats.`
  }
  return undefined
}

export function patternLine(input: { pattern: string; days: readonly string[] }): string {
  const clean = input.pattern.replace(/\s+/g, ' ').trim().slice(0, 500)
  return `- ${clean} (days: ${[...input.days].sort().join(', ')})`
}
