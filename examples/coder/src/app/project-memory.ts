/** Project memory: `AGENTS.md` at the root (fallback `CLAUDE.md`) plus nested `AGENTS.md` paths. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { glob } from 'tinyglobby'

const MAX_CHARS = 40_000
const MAX_NESTED = 50

async function tryRead(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/** Load the root memory file and list the other `AGENTS.md` files as virtual paths. */
export async function loadProjectMemory(
  root: string,
): Promise<{ text?: string; file?: string; nested: string[] }> {
  let file: string | undefined
  let text: string | undefined
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const content = await tryRead(join(root, name))
    if (content !== undefined) {
      file = name
      text = content
      break
    }
  }
  if (text !== undefined && text.length > MAX_CHARS) {
    text = `${text.slice(0, MAX_CHARS)}\n\n[truncated: ${file} is longer than ${MAX_CHARS} characters]`
  }

  const found = await glob('**/AGENTS.md', {
    cwd: root,
    ignore: ['**/node_modules/**', '**/.git/**'],
    dot: false,
  })
  const nested = found
    .filter((p) => p !== 'AGENTS.md')
    .sort()
    .slice(0, MAX_NESTED)
    .map((p) => `/${p}`)
  return { text, file, nested }
}
