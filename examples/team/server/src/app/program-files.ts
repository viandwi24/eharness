/**
 * Program files (docs/plans/P57-library-structure.md): a program can keep its brief and its
 * agreements as library files (`/library/programs/<slug>/brief.md`, `notes.md`). Every run reads the
 * current file (so an edit applies at once and the library history keeps every version); the text in
 * the program record stays as the fallback copy.
 *
 * A file only supplies text. The authority, forbidden list, gates and budget are fields of the
 * record: a file can never grant access (the run prompt says so, and nothing here reads them from
 * a file). A missing or unreadable file never stops a run: it runs on the fallback copy and raises
 * an alarm (a finding the owner sees) naming the file.
 */
import { conflict, invalid } from '../domain/errors.ts'
import { localDay } from '../domain/heartbeat.ts'
import {
  notesFromFile,
  notesToFile,
  PROGRAMS_DIR,
  programBriefPath,
  programNotesPath,
  slugify,
} from '../domain/library-structure.ts'
import { MAX_BRIEF_CHARS, MAX_NOTE_CHARS, MAX_NOTES, type Program } from '../domain/programs.ts'
import { raiseAlarm } from './alarms.ts'
import type { Deps } from './ports.ts'

const clip = (text: string, n: number): string =>
  text.length <= n ? text : `${text.slice(0, n - 1)}…`

interface Read {
  text?: string
  version?: string
  problem?: string
}

async function readText(deps: Deps, path: string): Promise<Read> {
  try {
    const file = await deps.library.read(path)
    if (file === undefined) return { problem: 'the file is missing' }
    if (file.text === null) return { problem: 'the file is not text' }
    return { text: file.text, version: file.meta.version }
  } catch (error) {
    return {
      problem: `the file could not be read (${error instanceof Error ? error.message : String(error)})`,
    }
  }
}

/**
 * The program as a run sees it: the brief and the notes from their files when the program is in
 * file mode. A file that cannot be used leaves the fallback copy in place and is returned in
 * `problems` (already raised as an alarm unless `raise` is false).
 */
export async function resolveProgramText(
  deps: Deps,
  program: Program,
  options: { raise?: boolean } = {},
): Promise<{ program: Program; problems: string[] }> {
  if (program.briefPath == null && program.notesPath == null) return { program, problems: [] }
  const problems: string[] = []
  let out = program
  if (program.briefPath != null) {
    const read = await readText(deps, program.briefPath)
    const text = read.text?.trim()
    if (text !== undefined && text !== '') out = { ...out, brief: clip(text, MAX_BRIEF_CHARS) }
    else
      problems.push(`the brief file ${program.briefPath}: ${read.problem ?? 'the file is empty'}`)
  }
  if (program.notesPath != null) {
    const read = await readText(deps, program.notesPath)
    if (read.text !== undefined) {
      out = {
        ...out,
        notes: notesFromFile(read.text)
          .map((n) => clip(n, MAX_NOTE_CHARS))
          .slice(0, MAX_NOTES),
      }
    } else problems.push(`the notes file ${program.notesPath}: ${read.problem ?? 'unreadable'}`)
  }
  if (problems.length > 0 && options.raise !== false) raiseFileFinding(deps, program, problems)
  return { program: out, problems }
}

/** One alarm per program, file and local day: the run went on with the saved copy. */
function raiseFileFinding(deps: Deps, program: Program, problems: string[]): void {
  try {
    const day = localDay(deps.clock.now(), deps.settings.get().timezone)
    raiseAlarm(deps, {
      kind: 'system',
      key: `program-file:${program.id}:${day}`,
      subject: `program:${program.id}`,
      agentId: program.agentId,
      text: `The program "${clip(program.name, 80)}" ran on its saved copy: ${problems.join('; ')}. Next: restore the file in the Library (its history keeps every version), or switch the program back to text on its page.`,
      refs: [`/programs/${program.id}`],
    })
  } catch {
    // the run must not fail because a finding could not be stored
  }
}

// --- moving a program to files ---------------------------------------------------------------------

export interface ProgramFileItem {
  programId: string
  name: string
  agentId: string
  briefPath: string | null
  notesPath: string | null
  briefChars: number
  notes: number
  /** `ready`: will be written; `already`: in file mode; `blocked`: see `note`. */
  status: 'ready' | 'already' | 'blocked'
  note: string | null
}

const suffixOf = (id: string): string =>
  id
    .replace(/[^a-z0-9]/gi, '')
    .slice(-6)
    .toLowerCase() || 'x'

/** Which programs would move, and to which files (nothing is written). */
export async function previewProgramFiles(
  deps: Deps,
  programIds?: readonly string[],
): Promise<ProgramFileItem[]> {
  const all = deps.programs.list({})
  const chosen = programIds === undefined ? all : all.filter((p) => programIds.includes(p.id))
  const existing = new Set(
    deps.library.list({ prefix: `${PROGRAMS_DIR}/`, limit: 5000 }).map((m) => m.path),
  )
  const claimed = new Set(
    all.flatMap((p) => [p.briefPath, p.notesPath].filter((x): x is string => x != null)),
  )
  const items: ProgramFileItem[] = []
  for (const p of chosen) {
    if (p.briefPath != null) {
      items.push({
        programId: p.id,
        name: p.name,
        agentId: p.agentId,
        briefPath: p.briefPath,
        notesPath: p.notesPath,
        briefChars: p.brief.length,
        notes: p.notes.length,
        status: 'already',
        note: null,
      })
      continue
    }
    const slug = slugify(p.name)
    const taken = (path: string): boolean => existing.has(path) || claimed.has(path)
    let name = slug
    if (taken(programBriefPath(name)) || taken(programNotesPath(name))) {
      name = `${slug}-${suffixOf(p.id)}`
    }
    let note: string | null = null
    if (name !== slug) note = `${slug}/ is taken: written to ${name}/ instead`
    let status: ProgramFileItem['status'] = 'ready'
    if (taken(programBriefPath(name)) || taken(programNotesPath(name))) {
      status = 'blocked'
      note = `${name}/ is taken too: rename the program or move the files by hand`
    }
    if (status === 'ready') {
      claimed.add(programBriefPath(name))
      claimed.add(programNotesPath(name))
    }
    items.push({
      programId: p.id,
      name: p.name,
      agentId: p.agentId,
      briefPath: programBriefPath(name),
      notesPath: programNotesPath(name),
      briefChars: p.brief.length,
      notes: p.notes.length,
      status,
      note,
    })
  }
  return items
}

export interface ProgramFilesResult {
  moved: number
  already: number
  failed: Array<{ programId: string; error: string }>
  items: ProgramFileItem[]
}

/**
 * Write the files and switch the programs to file mode. Each file is created (never overwritten) and
 * read back before the record changes; the old text stays in the record as the fallback copy.
 */
export async function applyProgramFiles(
  deps: Deps,
  programIds?: readonly string[],
): Promise<ProgramFilesResult> {
  const items = await previewProgramFiles(deps, programIds)
  const failed: ProgramFilesResult['failed'] = []
  let moved = 0
  for (const item of items) {
    if (item.status !== 'ready' || item.briefPath === null || item.notesPath === null) continue
    const program = deps.programs.get(item.programId)
    if (program === undefined || program.briefPath != null) continue
    try {
      const wrote = [
        { path: item.briefPath, text: program.brief },
        { path: item.notesPath, text: notesToFile(program.name, program.notes) },
      ]
      for (const f of wrote) {
        const out = await deps.library.writeText(f.path, f.text, null)
        if (!out.ok) throw new Error(`${f.path} already exists`)
        const back = await readText(deps, f.path)
        if (back.text !== f.text) throw new Error(`${f.path} did not read back as written`)
      }
      deps.programs.update(
        program.id,
        { briefPath: item.briefPath, notesPath: item.notesPath },
        deps.clock.now(),
      )
      deps.events.append({
        type: 'program-changed',
        agentId: program.agentId,
        payload: { programId: program.id, name: program.name, change: 'moved to the library' },
      })
      moved++
    } catch (error) {
      failed.push({
        programId: item.programId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { moved, already: items.filter((i) => i.status === 'already').length, failed, items }
}

// --- notes of a program in file mode ---------------------------------------------------------------

/**
 * `program_note` of a program whose agreements are a file: add and remove edit the file (a new
 * library version), and the record keeps the same list as its fallback copy.
 */
export async function noteInFile(
  deps: Deps,
  program: Program,
  input: { action: 'list' | 'add' | 'remove'; text?: string | undefined },
): Promise<string> {
  const path = program.notesPath as string
  const render = (notes: readonly string[]): string =>
    notes.length === 0
      ? `Program "${program.name}" (${program.id}) has no standing agreements.`
      : `Standing agreements of "${program.name}" (${program.id}):\n${notes.map((n, i) => `${i + 1}. ${n}`).join('\n')}`
  const read = await readText(deps, path)
  if (read.text === undefined) {
    throw conflict(
      `The agreements of "${program.name}" are the library file ${path}, but ${read.problem ?? 'it cannot be read'}. Ask the owner to restore it.`,
      'NOTES_FILE_UNAVAILABLE',
    )
  }
  let notes = notesFromFile(read.text)
  if (input.action === 'list') return render(notes)
  const text = input.text?.trim() ?? ''
  if (text === '') throw invalid('`text` is required', 'INVALID_NOTE')
  if (input.action === 'add') {
    if (text.length > MAX_NOTE_CHARS) {
      throw invalid(`a note has at most ${MAX_NOTE_CHARS} characters`, 'INVALID_NOTE')
    }
    if (notes.includes(text)) return `Already noted.\n${render(notes)}`
    if (notes.length >= MAX_NOTES) {
      throw invalid(`a program has at most ${MAX_NOTES} notes: remove one first`, 'INVALID_NOTE')
    }
    notes = [...notes, text]
  } else {
    const index = /^#?\d+$/.test(text) ? Number(text.replace('#', '')) - 1 : notes.indexOf(text)
    if (index < 0 || index >= notes.length) {
      throw invalid(`no such note. ${render(notes)}`, 'INVALID_NOTE')
    }
    notes = notes.filter((_, i) => i !== index)
  }
  const out = await deps.library.writeText(
    path,
    notesToFile(program.name, notes),
    read.version ?? undefined,
  )
  if (!out.ok) {
    throw conflict(`${path} changed while saving: try again`, 'VERSION_CONFLICT')
  }
  deps.programs.update(program.id, { notes }, deps.clock.now())
  return `${input.action === 'add' ? 'Noted' : 'Removed'}.\n${render(notes)}`
}

/** Write a program file as a new library version (nothing when the text is already there). */
export async function writeProgramFile(deps: Deps, path: string, text: string): Promise<void> {
  const cur = await readText(deps, path)
  if (cur.text === text) return
  const out = await deps.library.writeText(path, text, undefined)
  if (!out.ok) throw conflict(`${path} could not be written`, 'FILE_WRITE_FAILED')
}
