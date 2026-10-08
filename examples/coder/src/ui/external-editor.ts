/** Edit the prompt in `$VISUAL` / `$EDITOR` (Ctrl+G): temp file, foreground child, read back. */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Runs the editor command with the terminal attached; resolves with its exit code. */
export type SpawnEditor = (cmd: string, args: string[]) => Promise<number | null>

/** Overridable parts of {@link editInExternalEditor} (tests inject fakes). */
export interface ExternalEditorDeps {
  env?: Record<string, string | undefined>
  spawn?: SpawnEditor
  /** Wraps the child (the PromptInput passes Ink's `suspendTerminal`). */
  suspend?: (run: () => Promise<void>) => Promise<void>
  tempDir?: () => Promise<string>
}

/** Outcome of an external edit. */
export type ExternalEditResult = { ok: true; text: string } | { ok: false; error: string }

/** Split a command line (`code -w`, `"my editor" --flag`) into program and arguments. */
export function splitCommand(line: string): string[] {
  const parts: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (const m of line.matchAll(re)) parts.push(m[1] ?? m[2] ?? m[3] ?? '')
  return parts
}

/** `$VISUAL`, then `$EDITOR`, then `vi`. */
export function resolveEditor(env: Record<string, string | undefined>): string[] {
  const line = [env.VISUAL, env.EDITOR].find((v) => v !== undefined && v.trim() !== '') ?? 'vi'
  return splitCommand(line)
}

const defaultSpawn: SpawnEditor = (cmd, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => resolve(code))
  })

/** Write `text` to a temp file, run the editor on it, return the edited text. Never throws. */
export async function editInExternalEditor(
  text: string,
  deps: ExternalEditorDeps = {},
): Promise<ExternalEditResult> {
  const [cmd, ...args] = resolveEditor(deps.env ?? process.env)
  if (!cmd) return { ok: false, error: 'No editor configured' }
  let dir: string | undefined
  try {
    dir = await (deps.tempDir ?? (() => mkdtemp(join(tmpdir(), 'coder-edit-'))))()
    const file = join(dir, 'prompt.md')
    await writeFile(file, text, 'utf8')
    const exit: { code: number | null } = { code: null }
    const runEditor = async (): Promise<void> => {
      exit.code = await (deps.spawn ?? defaultSpawn)(cmd, [...args, file])
    }
    await (deps.suspend ? deps.suspend(runEditor) : runEditor())
    if (exit.code !== 0) {
      return { ok: false, error: `Editor exited with code ${String(exit.code)}` }
    }
    const edited = await readFile(file, 'utf8')
    return { ok: true, text: edited.replace(/\r\n/g, '\n').replace(/\n$/, '') }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
