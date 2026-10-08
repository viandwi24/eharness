/**
 * Configuration: settings files (user, project, local) merged with the CLI flags
 * (docs/plans/P30-coder-example.md §4).
 */
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod/v4'
import {
  type AgentDefinitionInput,
  type CoderConfig,
  type CoderSettings,
  PERMISSION_MODES,
  type PermissionMode,
  type PermissionRules,
  type PrintOptions,
} from '../contracts.ts'

/** Raw CLI flags as parsed by the command line (all optional). */
export interface CliFlags {
  cwd?: string
  model?: string
  permissionMode?: string
  addDir?: string[]
  allowedTools?: string[]
  disallowedTools?: string[]
  /** JSON object: name → agent definition. */
  agents?: string
  continue?: boolean
  resume?: string | true
  maxSteps?: number
  print?: string
  outputFormat?: string
  /** Trust this project's `.coder/` content before loading (`--trust-project`). */
  trustProject?: boolean
}

const modeSchema = z.enum(PERMISSION_MODES as [PermissionMode, ...PermissionMode[]])

const settingsSchema = z.object({
  model: z.string().min(1).optional(),
  contextWindow: z.number().int().positive().optional(),
  permissions: z
    .object({
      allow: z.array(z.string()).optional(),
      ask: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
      defaultMode: modeSchema.optional(),
      additionalDirectories: z.array(z.string()).optional(),
    })
    .optional(),
  mcpServers: z.record(z.string(), z.unknown()).optional(),
})

const agentsSchema = z.record(
  z.string(),
  z.object({
    description: z.string(),
    prompt: z.string(),
    tools: z.array(z.string()).optional(),
    disallowedTools: z.array(z.string()).optional(),
    model: z.string().optional(),
    permissionMode: modeSchema.optional(),
    maxTurns: z.number().int().positive().optional(),
    omitProjectMemory: z.boolean().optional(),
  }),
)

const FORMATS = ['text', 'json', 'stream-json'] as const

const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.6'

async function readSettings(file: string): Promise<CoderSettings | undefined> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`Cannot read settings file ${file}: ${(error as Error).message}`)
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    throw new Error(`Invalid JSON in settings file ${file}: ${(error as Error).message}`)
  }
  const parsed = settingsSchema.safeParse(json)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
    throw new Error(`Invalid settings file ${file}: ${issues}`)
  }
  return parsed.data as CoderSettings
}

const dedupe = (list: string[]): string[] => [...new Set(list)]

async function resolveDirs(
  dirs: string[],
  base: string,
  origin: string,
  warnings: string[],
): Promise<string[]> {
  const out: string[] = []
  for (const dir of dirs) {
    const expanded = dir.startsWith('~/') ? join(homedir(), dir.slice(2)) : dir
    const abs = isAbsolute(expanded) ? expanded : resolve(base, expanded)
    try {
      out.push(await realpath(abs))
    } catch {
      warnings.push(`Ignoring missing directory ${abs} (${origin})`)
    }
  }
  return out
}

// ─── Project trust ───────────────────────────────────────────────────────────────────────────
// `<root>/.coder/settings.json`, `.coder/agents` and `.coder/skills` come with the repository, so
// a cloned repo could widen permissions or spawn MCP servers. They only take effect once the user
// trusted exactly this content: `<userDir>/trusted.json` maps the real root to a content hash.

async function walkFiles(dir: string, base = ''): Promise<string[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = base === '' ? entry.name : `${base}/${entry.name}`
    if (entry.isDirectory()) out.push(...(await walkFiles(join(dir, entry.name), rel)))
    else out.push(rel)
  }
  return out
}

/** Names of the project agent and skill files (empty lists when the directories do not exist). */
async function projectContentFiles(root: string): Promise<{ agents: string[]; skills: string[] }> {
  const agents = (await walkFiles(join(root, '.coder', 'agents'))).filter(
    (f) => f.endsWith('.md') && !f.includes('/'),
  )
  const skills = await walkFiles(join(root, '.coder', 'skills'))
  return { agents, skills }
}

/** Hash of the project settings file content plus every project agent and skill file. */
async function projectHash(root: string): Promise<string> {
  const hash = createHash('sha256')
  const feed = async (label: string, file: string): Promise<void> => {
    let content: Buffer | string = ''
    try {
      content = await readFile(file)
    } catch {
      // missing or unreadable: hashed as empty
    }
    hash.update(`${label}\0`).update(content).update('\0')
  }
  await feed('settings', join(root, '.coder', 'settings.json'))
  const { agents, skills } = await projectContentFiles(root)
  for (const f of agents) await feed(`agent:${f}`, join(root, '.coder', 'agents', f))
  for (const f of skills) await feed(`skill:${f}`, join(root, '.coder', 'skills', f))
  return hash.digest('hex')
}

async function readTrusted(userDir: string): Promise<Record<string, string>> {
  try {
    const json = JSON.parse(await readFile(join(userDir, 'trusted.json'), 'utf8')) as unknown
    if (json !== null && typeof json === 'object' && !Array.isArray(json)) {
      return json as Record<string, string>
    }
  } catch {
    // missing or corrupt: nothing is trusted
  }
  return {}
}

async function writeTrusted(userDir: string, root: string, hash: string): Promise<void> {
  await mkdir(userDir, { recursive: true })
  const all = { ...(await readTrusted(userDir)), [root]: hash }
  const file = join(userDir, 'trusted.json')
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(all, null, 2)}\n`)
  await rename(temp, file)
}

/**
 * Trust the current content of this project's `.coder/` settings, agents and skills: records its
 * hash in `<userDir>/trusted.json`. Any later change of that content makes the project untrusted
 * again. Reload the config (`loadConfig`) afterwards to pick the trusted settings up.
 */
export async function trustProject(config: Pick<CoderConfig, 'root' | 'userDir'>): Promise<void> {
  await writeTrusted(config.userDir, config.root, await projectHash(config.root))
}

/** The risky keys of a project settings file that are set. */
function riskyKeys(settings: CoderSettings): string[] {
  const p = settings.permissions
  const keys: string[] = []
  if (p?.defaultMode !== undefined) keys.push('defaultMode')
  if (p?.allow !== undefined && p.allow.length > 0) keys.push('allow')
  if (p?.additionalDirectories !== undefined && p.additionalDirectories.length > 0) {
    keys.push('additionalDirectories')
  }
  if (settings.mcpServers !== undefined && Object.keys(settings.mcpServers).length > 0) {
    keys.push('mcpServers')
  }
  return keys
}

/** Settings without the keys that need trust (`ask` and `deny` only tighten, so they stay). */
function withoutRisky(settings: CoderSettings): CoderSettings {
  const { mcpServers: _mcp, permissions, ...rest } = settings
  if (permissions === undefined) return rest
  const { defaultMode: _m, allow: _a, additionalDirectories: _d, ...safe } = permissions
  return { ...rest, permissions: safe }
}

/** No project settings file: only project agents and skills can need trust. */
async function projectAgentsSkillsTrusted(
  root: string,
  userDir: string,
  untrusted: string[],
): Promise<boolean> {
  const { agents, skills } = await projectContentFiles(root)
  const risky = [...(agents.length > 0 ? ['agents'] : []), ...(skills.length > 0 ? ['skills'] : [])]
  if (risky.length === 0) return true
  if ((await readTrusted(userDir))[root] === (await projectHash(root))) return true
  untrusted.push(...risky)
  return false
}

/** What {@link loadConfig} returns. */
export type LoadedConfig = CoderConfig & {
  warnings: string[]
  /** A settings file set `contextWindow` (it then beats the models.dev catalog). */
  contextWindowExplicit: boolean
}

/** Load settings files, merge them with the flags and prepare the data directories. */
export async function loadConfig(flags: CliFlags): Promise<LoadedConfig> {
  const warnings: string[] = []
  const root = await realpath(resolve(flags.cwd ?? process.cwd()))
  const userDir = process.env.CODER_HOME ?? join(homedir(), '.coder')
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 16)
  const projectDataDir = join(userDir, 'projects', hash)
  await mkdir(join(projectDataDir, 'sessions'), { recursive: true })
  await mkdir(join(projectDataDir, 'tool-outputs'), { recursive: true })

  const settingsFiles = {
    user: join(userDir, 'settings.json'),
    project: join(root, '.coder', 'settings.json'),
    local: join(root, '.coder', 'settings.local.json'),
  }

  let model: string | undefined
  let contextWindow: number | undefined
  let mode: PermissionMode | undefined
  const rules: PermissionRules = { allow: [], ask: [], deny: [] }
  const dirs: string[] = []
  const mcpServers: Record<string, unknown> = {}

  if (flags.trustProject) await trustProject({ root, userDir })
  const untrusted: string[] = []
  let trusted = true

  for (const file of [settingsFiles.user, settingsFiles.project, settingsFiles.local]) {
    let settings = await readSettings(file)
    if (!settings) {
      if (file === settingsFiles.project)
        trusted = await projectAgentsSkillsTrusted(root, userDir, untrusted)
      continue
    }
    if (file === settingsFiles.project) {
      const risky = riskyKeys(settings)
      const { agents, skills } = await projectContentFiles(root)
      if (agents.length > 0) risky.push('agents')
      if (skills.length > 0) risky.push('skills')
      if (risky.length > 0 && (await readTrusted(userDir))[root] !== (await projectHash(root))) {
        trusted = false
        untrusted.push(...risky)
        settings = withoutRisky(settings)
      }
    }
    model = settings.model ?? model
    contextWindow = settings.contextWindow ?? contextWindow
    const p = settings.permissions
    if (p) {
      mode = p.defaultMode ?? mode
      rules.allow.push(...(p.allow ?? []))
      rules.ask.push(...(p.ask ?? []))
      rules.deny.push(...(p.deny ?? []))
      if (p.additionalDirectories) {
        // relative to the directory that holds the settings (the project root for `.coder/`)
        const base = file === settingsFiles.user ? dirname(file) : root
        dirs.push(...(await resolveDirs(p.additionalDirectories, base, file, warnings)))
      }
    }
    Object.assign(mcpServers, settings.mcpServers)
  }

  if (flags.permissionMode !== undefined) {
    const parsed = modeSchema.safeParse(flags.permissionMode)
    if (!parsed.success) {
      throw new Error(
        `Invalid permission mode "${flags.permissionMode}". Use one of: ${PERMISSION_MODES.join(', ')}`,
      )
    }
    mode = parsed.data
  }
  rules.allow.push(...(flags.allowedTools ?? []))
  rules.deny.push(...(flags.disallowedTools ?? []))
  dirs.push(...(await resolveDirs(flags.addDir ?? [], root, '--add-dir', warnings)))

  let cliAgents: Record<string, AgentDefinitionInput> = {}
  if (flags.agents !== undefined) {
    let json: unknown
    try {
      json = JSON.parse(flags.agents)
    } catch (error) {
      throw new Error(`Invalid JSON for --agents: ${(error as Error).message}`)
    }
    const parsed = agentsSchema.safeParse(json)
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
      throw new Error(`Invalid --agents: ${issues}`)
    }
    cliAgents = parsed.data
  }

  let print: PrintOptions | undefined
  if (flags.print !== undefined) {
    const format = flags.outputFormat ?? 'text'
    if (!(FORMATS as readonly string[]).includes(format)) {
      throw new Error(`Invalid --output-format "${format}". Use one of: ${FORMATS.join(', ')}`)
    }
    print = { prompt: flags.print, format: format as PrintOptions['format'] }
  }

  // unique by real path; a dir equal to the root is pointless
  const additionalDirectories = dedupe(dirs).filter((d) => d !== root)

  return {
    root,
    userDir,
    projectDataDir,
    settingsFiles,
    model: flags.model ?? model ?? process.env.CODER_MODEL ?? DEFAULT_MODEL,
    contextWindow: contextWindow ?? 200_000,
    mode: mode ?? 'default',
    rules: { allow: dedupe(rules.allow), ask: dedupe(rules.ask), deny: dedupe(rules.deny) },
    additionalDirectories,
    cliAgents,
    maxSteps: flags.maxSteps ?? 200,
    maxAgentDepth: 2,
    mcpServers,
    print,
    continueLast: flags.continue ?? false,
    resume: flags.resume,
    untrusted,
    trusted,
    warnings,
    contextWindowExplicit: contextWindow !== undefined,
  }
}
