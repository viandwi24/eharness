/** Loads subagent definitions from `--agents` JSON, project and user Markdown files, built-ins. */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseSkillMarkdown } from 'eharness'
import {
  type AgentDefinition,
  type AgentDefinitionInput,
  PERMISSION_MODES,
  type PermissionMode,
  TOOL,
} from '../contracts.ts'
import { BUILTIN_AGENTS } from './builtin.ts'

const ALIASES: Record<string, string[]> = {
  Read: [TOOL.read, TOOL.list],
  Grep: [TOOL.grep],
  Glob: [TOOL.glob],
  Edit: [TOOL.edit, TOOL.write, TOOL.delete],
  Write: [TOOL.write],
  Bash: [TOOL.bash],
  Agent: [TOOL.agent],
  Task: [TOOL.agent],
  TodoWrite: [TOOL.todo],
}

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** Maps tool aliases (`Read`, `Edit`, `Bash`, …) to real tool names; real names pass through. */
export function expandToolNames(names: readonly string[]): string[] {
  const out: string[] = []
  for (const raw of names) {
    // `Agent(explore)` style restrictions are not supported: the base name is used
    const name = raw.trim().replace(/\(.*\)$/, '')
    if (name === '') continue
    for (const real of ALIASES[name] ?? [name]) if (!out.includes(real)) out.push(real)
  }
  return out
}

function normalize<T extends AgentDefinitionInput>(def: T): T {
  const out = { ...def }
  if (def.tools !== undefined) out.tools = expandToolNames(def.tools)
  if (def.disallowedTools !== undefined) out.disallowedTools = expandToolNames(def.disallowedTools)
  return out
}

function toList(value: unknown): string[] | undefined {
  if (typeof value === 'string')
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  return undefined
}

function parseMarkdownAgent(
  text: string,
  file: string,
  source: 'project' | 'user',
): AgentDefinition | string {
  const parsed = parseSkillMarkdown(text)
  if ('error' in parsed) return parsed.error
  const { name, description } = parsed.meta
  if (!NAME.test(name))
    return `invalid agent name "${name}" (use lowercase letters, digits, hyphens)`
  if (parsed.body.trim() === '') return 'the prompt (file body) is empty'
  const meta = parsed.meta.meta ?? {}
  const def: AgentDefinition = { name, description, prompt: parsed.body.trim(), source, file }
  const tools = toList(meta.tools)
  if (tools !== undefined) def.tools = tools
  const disallowed = toList(meta.disallowedTools)
  if (disallowed !== undefined) def.disallowedTools = disallowed
  if (typeof meta.model === 'string' && meta.model !== '') def.model = meta.model
  if (meta.permissionMode !== undefined) {
    if (!PERMISSION_MODES.includes(meta.permissionMode as PermissionMode)) {
      return `invalid permissionMode "${String(meta.permissionMode)}"`
    }
    def.permissionMode = meta.permissionMode as PermissionMode
  }
  if (meta.maxTurns !== undefined) {
    if (
      typeof meta.maxTurns !== 'number' ||
      !Number.isInteger(meta.maxTurns) ||
      meta.maxTurns < 1
    ) {
      return 'maxTurns must be a positive integer'
    }
    def.maxTurns = meta.maxTurns
  }
  if (typeof meta.omitProjectMemory === 'boolean') def.omitProjectMemory = meta.omitProjectMemory
  return normalize(def)
}

async function loadDir(
  dir: string,
  source: 'project' | 'user',
  warnings: string[],
): Promise<AgentDefinition[]> {
  let files: string[]
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort()
  } catch {
    return []
  }
  const out: AgentDefinition[] = []
  for (const f of files) {
    const file = join(dir, f)
    try {
      const result = parseMarkdownAgent(await readFile(file, 'utf8'), file, source)
      if (typeof result === 'string') warnings.push(`Skipped agent file ${file}: ${result}`)
      else out.push(result)
    } catch (error) {
      warnings.push(`Skipped agent file ${file}: ${String(error)}`)
    }
  }
  return out
}

/**
 * Loads every subagent definition. On a name collision the first source wins: `--agents` JSON,
 * `<root>/.coder/agents/*.md`, `<userDir>/agents/*.md`, built-ins. Invalid entries are skipped
 * with a warning that names the file or agent.
 */
export async function loadAgentDefinitions(opts: {
  root: string
  userDir: string
  cliAgents: Record<string, AgentDefinitionInput>
  /** Load `<root>/.coder/agents`; false while the project is untrusted. Default true. */
  loadProject?: boolean
}): Promise<{ definitions: AgentDefinition[]; warnings: string[] }> {
  const warnings: string[] = []
  const cli: AgentDefinition[] = []
  for (const [name, input] of Object.entries(opts.cliAgents)) {
    if (!NAME.test(name)) {
      warnings.push(
        `Skipped --agents entry "${name}": invalid name (lowercase letters, digits, hyphens)`,
      )
    } else if (typeof input?.description !== 'string' || input.description.trim() === '') {
      warnings.push(`Skipped --agents entry "${name}": description is required`)
    } else if (typeof input.prompt !== 'string' || input.prompt.trim() === '') {
      warnings.push(`Skipped --agents entry "${name}": prompt is required`)
    } else {
      cli.push({ ...normalize(input), name, source: 'cli' })
    }
  }
  const project =
    opts.loadProject === false
      ? []
      : await loadDir(join(opts.root, '.coder', 'agents'), 'project', warnings)
  const user = await loadDir(join(opts.userDir, 'agents'), 'user', warnings)
  const byName = new Map<string, AgentDefinition>()
  for (const def of [...cli, ...project, ...user, ...BUILTIN_AGENTS]) {
    if (!byName.has(def.name)) byName.set(def.name, def)
  }
  return { definitions: [...byName.values()], warnings }
}
