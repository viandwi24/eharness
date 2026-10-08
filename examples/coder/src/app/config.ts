/**
 * Configuration: settings files (user, project, local) merged with the CLI flags
 * (docs/plans/P30-coder-example.md §4).
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath } from 'node:fs/promises'
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

/** Load settings files, merge them with the flags and prepare the data directories. */
export async function loadConfig(flags: CliFlags): Promise<CoderConfig & { warnings: string[] }> {
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

  for (const file of [settingsFiles.user, settingsFiles.project, settingsFiles.local]) {
    const settings = await readSettings(file)
    if (!settings) continue
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
    warnings,
  }
}
