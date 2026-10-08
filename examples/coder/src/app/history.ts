/**
 * Prompt history: `<userDir>/history.jsonl`, one `{ at, project, text }` JSON line per submitted
 * prompt. Consecutive duplicates are dropped and the file keeps at most 1000 lines.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Most lines the history file keeps. */
export const HISTORY_MAX_LINES = 1000

interface HistoryLine {
  at: number
  project: string
  text: string
}

const writes = new Map<string, Promise<unknown>>()

function parseLines(raw: string): HistoryLine[] {
  const out: HistoryLine[] = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      const entry = JSON.parse(line) as Partial<HistoryLine>
      if (typeof entry.text === 'string' && typeof entry.project === 'string') {
        out.push({
          at: typeof entry.at === 'number' ? entry.at : 0,
          project: entry.project,
          text: entry.text,
        })
      }
    } catch {
      // a corrupt line is skipped
    }
  }
  return out
}

async function readAll(file: string): Promise<HistoryLine[]> {
  try {
    return parseLines(await readFile(file, 'utf8'))
  } catch {
    return []
  }
}

/**
 * Append a prompt. A prompt equal to the previous entry of the same project is not stored twice;
 * writes are serialized per file and the file is rewritten atomically when it has to be trimmed.
 */
export async function addHistory(userDir: string, project: string, text: string): Promise<void> {
  const clean = text.trim()
  if (clean === '') return
  const file = join(userDir, 'history.jsonl')
  const previous = writes.get(file) ?? Promise.resolve()
  const next = previous
    .catch(() => {})
    .then(async () => {
      const lines = await readAll(file)
      const last = [...lines].reverse().find((l) => l.project === project)
      if (last?.text === clean) return
      lines.push({ at: Date.now(), project, text: clean })
      await mkdir(userDir, { recursive: true })
      const kept = lines.slice(-HISTORY_MAX_LINES)
      const body = `${kept.map((l) => JSON.stringify(l)).join('\n')}\n`
      const temp = `${file}.${process.pid}.tmp`
      await writeFile(temp, body)
      await rename(temp, file)
    })
  writes.set(file, next)
  await next
}

/** Prompts of this project (or of every project), oldest first, the newest `limit` of them (default 200). */
export async function readHistory(
  userDir: string,
  project: string,
  opts: { allProjects?: boolean; limit?: number } = {},
): Promise<string[]> {
  const lines = await readAll(join(userDir, 'history.jsonl'))
  const texts = lines
    .filter((l) => opts.allProjects === true || l.project === project)
    .map((l) => l.text)
  const limit = Math.max(0, Math.floor(opts.limit ?? 200))
  return limit === 0 ? [] : texts.slice(-limit)
}
