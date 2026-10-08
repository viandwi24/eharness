/**
 * Output styles: a named block of instructions that shapes how the agent answers.
 *
 * Built-ins: `default` (no extra text), `concise`, `explanatory`, `learning`. Custom styles are
 * Markdown files with frontmatter (`name`, `description`) in `<root>/.coder/output-styles/*.md`
 * (project, only when the project is trusted) and `<userDir>/output-styles/*.md` (user). A project
 * style beats a user style beats a built-in of the same name.
 *
 * Prompt-cache impact: the style text belongs in a SESSION instruction (the block after the static
 * instructions), never in the static prefix. Switching style changes that block, so the cache is
 * rebuilt from the session block onwards (tools and the static instructions stay cached). Switch
 * rarely; `default` adds no text at all.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseCommandFile } from './commands.ts'

/** One available style. */
export interface OutputStyle {
  name: string
  description: string
  /** Instruction text; empty for `default`. */
  instruction: string
  source: 'builtin' | 'project' | 'user'
}

export const BUILTIN_OUTPUT_STYLES: readonly OutputStyle[] = [
  {
    name: 'default',
    description: 'The standard coding-agent style.',
    instruction: '',
    source: 'builtin',
  },
  {
    name: 'concise',
    description: 'Terse answers: the result first, no preamble, no recap.',
    instruction: `# Output style: concise
Be terse. Lead with the result or the answer. No preamble, no restating the question, no closing summary of what you just did. Use short sentences and bullets only when they are shorter than prose. Skip explanations unless asked or unless a decision needs one. Code and command output speak for themselves; do not narrate them.`,
    source: 'builtin',
  },
  {
    name: 'explanatory',
    description: 'Adds brief "Insight" notes about design choices while working.',
    instruction: `# Output style: explanatory
While you work, add short "Insight" notes (1-3 sentences, prefixed with "Insight:") that explain a design choice, a codebase pattern or a trade-off you met, and why you chose what you chose. Put them next to the change they explain. Keep them specific to this codebase, never generic tutorials, and skip them for trivial edits. Your normal engineering rules do not change.`,
    source: 'builtin',
  },
  {
    name: 'learning',
    description: 'Collaborative: asks you to write small, meaningful parts yourself.',
    instruction: `# Output style: learning
Work collaboratively and help the user learn. For a meaningful but small piece of the change (a function body of 5-10 lines, a decision with trade-offs, a test case), do NOT write it yourself: leave a clearly marked \`TODO(human)\` placeholder in the code, say in one or two sentences what is needed and what to consider, then stop and wait. Implement everything else (scaffolding, plumbing, boilerplate) yourself. When the user returns their part, review it briefly and continue. Add short "Insight:" notes on design choices. Do not hand off trivial work.`,
    source: 'builtin',
  },
]

/** Options of the loaders. */
export interface OutputStyleSources {
  root: string
  /** `~/.coder` */
  userDir: string
  /** Project styles load only when the project's `.coder/` content is trusted. */
  trusted: boolean
}

async function loadDir(dir: string, source: 'project' | 'user'): Promise<OutputStyle[]> {
  let names: string[]
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith('.md')).sort()
  } catch {
    return []
  }
  const out: OutputStyle[] = []
  for (const file of names) {
    try {
      const { meta, body } = parseCommandFile(await readFile(join(dir, file), 'utf8'))
      const name = (meta.name ?? file.slice(0, -3)).trim()
      if (name === '' || body === '') continue
      out.push({
        name,
        description: meta.description?.trim() || `Custom style (${source}).`,
        instruction: `# Output style: ${name}\n${body}`,
        source,
      })
    } catch {
      // unreadable file: skipped
    }
  }
  return out
}

/** Built-in, user and (trusted) project styles; later sources override earlier ones by name. */
export async function loadOutputStyles(opts: OutputStyleSources): Promise<OutputStyle[]> {
  const byName = new Map<string, OutputStyle>()
  const all = [
    ...BUILTIN_OUTPUT_STYLES,
    ...(await loadDir(join(opts.userDir, 'output-styles'), 'user')),
    ...(opts.trusted ? await loadDir(join(opts.root, '.coder', 'output-styles'), 'project') : []),
  ]
  for (const style of all) byName.set(style.name, style)
  return [...byName.values()]
}

/**
 * The text of the session instruction for a style, or `undefined` for `default`, an empty style
 * or an unknown name.
 */
export function outputStyleInstruction(
  name: string | undefined,
  styles: readonly OutputStyle[],
): string | undefined {
  if (name === undefined) return undefined
  const text = styles.find((s) => s.name === name)?.instruction
  return text === undefined || text === '' ? undefined : text
}

/** Handle over the style sources (reads the files on every call, so edits are picked up). */
export interface OutputStyles {
  styles(): Promise<Array<{ name: string; description: string }>>
  /** Session instruction text for the style (see {@link outputStyleInstruction}). */
  instruction(name: string | undefined): Promise<string | undefined>
  /** Whether the style exists. */
  has(name: string): Promise<boolean>
}

export function createOutputStyles(opts: OutputStyleSources): OutputStyles {
  return {
    async styles() {
      return (await loadOutputStyles(opts)).map(({ name, description }) => ({ name, description }))
    },
    async instruction(name) {
      return outputStyleInstruction(name, await loadOutputStyles(opts))
    },
    async has(name) {
      return (await loadOutputStyles(opts)).some((s) => s.name === name)
    },
  }
}
