/**
 * The daily works journal (docs/plans/P57-library-structure.md, follow-up). Pure.
 *
 * One Markdown file per day, `<root>/YYYY/MM/DD.md` (default root `/library/works`, the day in the
 * team timezone). Agents append the day's cache, follow-ups and working notes to it; heartbeat and
 * program runs append one line with a link to their full report. Nothing here reads or writes:
 * `app/works-journal.ts` does that.
 */
import { invalid } from './errors.ts'
import { LIBRARY_ROOT } from './library.ts'
import { hasControlOrBackslash } from './text.ts'

export const WORKS_ROOT_DEFAULT = `${LIBRARY_ROOT}/works`
export const JOURNAL_ENTRY_MAX_CHARS = 1_500

/** The root as a clean absolute library folder (no trailing slash), or why it is refused. */
export function checkWorksRoot(raw: string): string {
  const root = raw.trim().replace(/\/+$/, '')
  const segments = root.split('/').slice(1)
  const ok =
    root.startsWith(`${LIBRARY_ROOT}/`) &&
    root.length <= 200 &&
    segments.length >= 2 &&
    segments.every((s) => s !== '' && s !== '.' && s !== '..' && !hasControlOrBackslash(s)) &&
    segments[1] !== '.eharness'
  if (!ok) {
    throw invalid(
      `worksRoot must be a folder under ${LIBRARY_ROOT}/, for example ${WORKS_ROOT_DEFAULT}`,
      'INVALID_SETTINGS',
    )
  }
  return root
}

/** The calendar parts of an instant in a timezone. */
export function dayParts(
  at: number,
  timezone: string,
): { y: string; m: string; d: string; hm: string } {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  const get = (type: string): string =>
    f.formatToParts(new Date(at)).find((p) => p.type === type)?.value ?? '00'
  return { y: get('year'), m: get('month'), d: get('day'), hm: `${get('hour')}:${get('minute')}` }
}

/** `<root>/YYYY/MM/DD.md` of the day `at` falls on in `timezone`. */
export function journalPath(root: string, at: number, timezone: string): string {
  const { y, m, d } = dayParts(at, timezone)
  return `${root.replace(/\/+$/, '')}/${y}/${m}/${d}.md`
}

export interface JournalEntry {
  /** Who wrote it: an agent name, `heartbeat` or a program name. */
  by: string
  /** One short line (a follow-up, a note, what a run did). Newlines are folded. */
  text: string
  /** Library path or URL of the full report, shown as a link. */
  link?: string | undefined
}

const oneLine = (text: string): string => text.replace(/\s*\n+\s*/g, ' ').trim()

/** `- 14:05 [heartbeat] text ([report](/library/...))`: one bullet, no newline inside. */
export function journalLine(entry: JournalEntry, at: number, timezone: string): string {
  const { hm } = dayParts(at, timezone)
  const text = oneLine(entry.text).slice(0, JOURNAL_ENTRY_MAX_CHARS)
  const link =
    entry.link === undefined || entry.link.trim() === ''
      ? ''
      : ` ([report](${entry.link.trim().replace(/[()\s]/g, encodeURIComponent)}))`
  return `- ${hm} [${oneLine(entry.by).slice(0, 80) || 'agent'}] ${text}${link}`
}

/** The file after one entry: a heading for a new day, then the bullets in order. */
export function appendJournal(
  existing: string | null,
  entry: JournalEntry,
  at: number,
  timezone: string,
): string {
  const { y, m, d } = dayParts(at, timezone)
  const head = `# Works ${y}-${m}-${d}\n\nCache, follow-ups and working notes of the day. Newest at the bottom.\n\n`
  const base =
    existing === null || existing === ''
      ? head
      : existing.endsWith('\n')
        ? existing
        : `${existing}\n`
  return `${base}${journalLine(entry, at, timezone)}\n`
}

/** The instruction every agent gets about the journal (static per root: prompt-cache prefix). */
export const journalProtocol = (root: string): string =>
  `- Daily journal: append today's follow-ups, cache and working notes as one bullet each to ${root}/YYYY/MM/DD.md (today's date in the team timezone; create the file with a "# Works YYYY-MM-DD" heading when it is missing, never rewrite earlier lines). Keep a bullet to one line; put long reports in ${LIBRARY_ROOT}/reports/ and link them from the bullet.`
