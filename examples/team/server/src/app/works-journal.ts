/**
 * The daily works journal use cases (domain/works-journal.ts): append one entry to today's file,
 * and the one-line entries heartbeat and program runs leave. Best effort: the journal never fails
 * the run it describes.
 */
import { appendJournal, type JournalEntry, journalPath } from '../domain/works-journal.ts'
import type { Deps } from './ports.ts'

const ATTEMPTS = 4

/** Appends to `<worksRoot>/YYYY/MM/DD.md` (team timezone). Returns the path, or undefined when it failed. */
export async function appendWorksJournal(
  deps: Deps,
  entry: JournalEntry,
  at: number = deps.clock.now(),
): Promise<string | undefined> {
  const { worksRoot, timezone } = deps.settings.get()
  const path = journalPath(worksRoot, at, timezone)
  try {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const file = await deps.library.read(path)
      const text = file === undefined ? null : (file.text ?? null)
      if (file !== undefined && file.text === null) return undefined // a binary file is in the way
      const next = appendJournal(text, entry, at, timezone)
      const change = await deps.library.writeText(
        path,
        next,
        file === undefined ? null : file.meta.version,
      )
      if (change.ok) return path
      if (change.reason === 'missing') return undefined
    }
  } catch {
    // the journal is a convenience: a failed append is not worth failing a run
  }
  return undefined
}

/** One line for a finished program run, linked to its first output (else the task page). */
export async function journalProgramRun(
  deps: Deps,
  program: { name: string },
  task: {
    id: string
    status: string
    summary: string | null
    report: { outputs: string[] } | null
  },
): Promise<void> {
  const link = task.report?.outputs[0] ?? `/tasks/${task.id}`
  await appendWorksJournal(deps, {
    by: `program ${program.name}`,
    text: `${task.status}: ${task.summary ?? 'run ended'}`,
    link,
  })
}

/** One line for a beat that had something to report, linked to its first reference. */
export async function journalBeat(
  deps: Deps,
  agentName: string,
  items: ReadonlyArray<{ title: string; links: readonly string[] }>,
  at: number,
): Promise<void> {
  if (items.length === 0) return
  const first = items[0]
  await appendWorksJournal(
    deps,
    {
      by: `heartbeat ${agentName}`,
      text: `${items.length} item(s): ${items.map((i) => i.title).join('; ')}`.slice(0, 400),
      link: first?.links[0],
    },
    at,
  )
}
