/**
 * Custom slash commands: Markdown files in `<root>/.coder/commands/**` (trusted projects only) and
 * `<userDir>/commands/**`, plus the project's skills. The command name is the file path without
 * `.md` with `/` written as `:` (`frontend/test.md` is `/frontend:test`).
 *
 * A command file may start with a frontmatter block (`description`, `argument-hint`, `model`; the
 * model is ignored). Its body is the prompt: `$ARGUMENTS` is the text typed after the command,
 * `$1`..`$9` its words (quotes group words).
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseSkillMarkdown } from 'eharness'
import type { CustomCommand } from '../contracts.ts'

/** Built-in slash commands: a custom command or skill may not take their names. */
export const BUILTIN_SLASH_COMMANDS: readonly string[] = [
  'help',
  'clear',
  'compact',
  'model',
  'thinking',
  'permissions',
  'agents',
  'transcript',
  'resume',
  'cost',
  'context',
  'status',
  'todos',
  'init',
  'exit',
  'diff',
]

/** A command with the text it expands to (`body` is absent for skills). */
export interface LoadedCommand extends CustomCommand {
  body?: string
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/

function unquote(value: string): string {
  const v = value.trim()
  if (v.length >= 2 && (v.startsWith('"') || v.startsWith("'")) && v.endsWith(v[0] as string)) {
    return v.slice(1, -1)
  }
  return v
}

/** Frontmatter (flat `key: value` lines) and body of a command file. */
export function parseCommandFile(text: string): { meta: Record<string, string>; body: string } {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  if ((lines[0] ?? '').trimEnd() !== '---') return { meta: {}, body: normalized.trim() }
  const end = lines.findIndex((line, i) => i > 0 && line.trimEnd() === '---')
  if (end === -1) return { meta: {}, body: normalized.trim() }
  const meta: Record<string, string> = {}
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (match?.[1] !== undefined) meta[match[1]] = unquote(match[2] ?? '')
  }
  return {
    meta,
    body: lines
      .slice(end + 1)
      .join('\n')
      .trim(),
  }
}

async function walk(dir: string, base = ''): Promise<string[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = base === '' ? entry.name : `${base}/${entry.name}`
    if (entry.isDirectory()) out.push(...(await walk(join(dir, entry.name), rel)))
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(rel)
  }
  return out
}

function firstLine(body: string): string {
  const line =
    body
      .split('\n')
      .find((l) => l.trim() !== '')
      ?.replace(/^#+\s*/, '')
      .trim() ?? ''
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

async function loadDir(
  dir: string,
  source: 'project' | 'user',
  warnings: string[],
): Promise<LoadedCommand[]> {
  const out: LoadedCommand[] = []
  for (const rel of await walk(dir)) {
    const name = rel.slice(0, -'.md'.length).split('/').join(':')
    const file = join(dir, rel)
    if (!NAME.test(name)) {
      warnings.push(`Skipped command file ${file}: invalid name "${name}"`)
      continue
    }
    if (BUILTIN_SLASH_COMMANDS.includes(name)) {
      warnings.push(`Skipped command file ${file}: /${name} is a built-in command`)
      continue
    }
    try {
      const { meta, body } = parseCommandFile(await readFile(file, 'utf8'))
      if (body === '') {
        warnings.push(`Skipped command file ${file}: the prompt (file body) is empty`)
        continue
      }
      const hint = meta['argument-hint']
      out.push({
        name,
        description: meta.description || firstLine(body),
        ...(hint ? { argumentHint: hint } : {}),
        source,
        body,
      })
    } catch (error) {
      warnings.push(`Skipped command file ${file}: ${String(error)}`)
    }
  }
  return out
}

async function loadSkills(root: string, warnings: string[]): Promise<LoadedCommand[]> {
  const base = join(root, '.coder', 'skills')
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(base, { withFileTypes: true })
  } catch {
    return []
  }
  const out: LoadedCommand[] = []
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isDirectory()) continue
    try {
      const parsed = parseSkillMarkdown(await readFile(join(base, entry.name, 'SKILL.md'), 'utf8'))
      if ('error' in parsed) continue
      const { name, description } = parsed.meta
      if (BUILTIN_SLASH_COMMANDS.includes(name)) {
        warnings.push(`Skipped skill "${name}" as a command: /${name} is a built-in command`)
        continue
      }
      out.push({ name, description, source: 'skill' })
    } catch {
      // not a skill
    }
  }
  return out
}

/**
 * Load the custom commands and skills. A project command beats a user command of the same name,
 * and either beats a skill. Project commands and skills load only for a trusted project.
 */
export async function loadCommands(opts: {
  root: string
  userDir: string
  trusted: boolean
}): Promise<{ commands: LoadedCommand[]; warnings: string[] }> {
  const warnings: string[] = []
  const project = opts.trusted
    ? await loadDir(join(opts.root, '.coder', 'commands'), 'project', warnings)
    : []
  const user = await loadDir(join(opts.userDir, 'commands'), 'user', warnings)
  const skills = opts.trusted ? await loadSkills(opts.root, warnings) : []
  const byName = new Map<string, LoadedCommand>()
  for (const command of [...project, ...user, ...skills]) {
    if (!byName.has(command.name)) byName.set(command.name, command)
  }
  return { commands: [...byName.values()], warnings }
}

/** Split typed arguments into words; single or double quotes group words. */
export function splitArguments(args: string): string[] {
  const words: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (let m = re.exec(args); m !== null; m = re.exec(args)) words.push(m[1] ?? m[2] ?? m[3] ?? '')
  return words
}

/**
 * The prompt a command sends: `$ARGUMENTS` and `$1`..`$9` are substituted. When the body uses no
 * placeholder and arguments were typed, they are appended as `ARGUMENTS: …`.
 */
export function expandBody(body: string, args: string): string {
  const trimmed = args.trim()
  const words = splitArguments(trimmed)
  let used = false
  let out = body.replace(/\$ARGUMENTS\b/g, () => {
    used = true
    return trimmed
  })
  out = out.replace(/\$([1-9])(?!\d)/g, (_, n: string) => {
    used = true
    return words[Number(n) - 1] ?? ''
  })
  return !used && trimmed !== '' ? `${out}\n\nARGUMENTS: ${trimmed}` : out
}

/** The prompt that invokes a skill. */
export function expandSkill(name: string, args: string): string {
  const trimmed = args.trim()
  return trimmed === ''
    ? `Use the skill "${name}" now.`
    : `Use the skill "${name}" (call load_skill first) for this request: ${trimmed}`
}
