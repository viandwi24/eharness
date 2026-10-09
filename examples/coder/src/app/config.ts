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
  type HookEvent,
  type ModelProvider,
  PERMISSION_MODES,
  type PermissionMode,
  type PermissionRules,
  type PrintOptions,
} from '../contracts.ts'
import { DEFAULT_MODEL, detectProvider, MODEL_PROVIDERS, parseProvider } from './provider.ts'

/** Raw CLI flags as parsed by the command line (all optional). */
export interface CliFlags {
  cwd?: string
  model?: string
  /** `openrouter` | `gateway`. */
  provider?: string
  /** `default` (alias `manual`), `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions`, `auto`. */
  permissionMode?: string
  /** Put `bypassPermissions` in the Shift+Tab cycle without starting in it. */
  allowDangerouslySkipPermissions?: boolean
  /** Start in `bypassPermissions` (also puts it in the cycle). */
  dangerouslySkipPermissions?: boolean
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

/** Every event a settings hook can run on. */
export const HOOK_EVENTS: readonly HookEvent[] = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Stop',
  'SubagentStop',
  'Notification',
  'SessionStart',
]

const hookEntrySchema = z.object({
  matcher: z.string().optional(),
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().optional(),
})

const settingsSchema = z.object({
  model: z.string().min(1).optional(),
  provider: z.enum(MODEL_PROVIDERS).optional(),
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
  autoMode: z
    .object({ model: z.string().min(1).optional(), enabled: z.boolean().optional() })
    .optional(),
  mcpServers: z.record(z.string(), z.unknown()).optional(),
  theme: z.enum(['dark', 'light', 'auto']).optional(),
  outputStyle: z.string().min(1).optional(),
  notifications: z.enum(['off', 'bell', 'desktop']).optional(),
  askUserQuestionTimeout: z.number().min(0).optional(),
  statusLine: z.object({ command: z.string().min(1) }).optional(),
  promptSuggestions: z.boolean().optional(),
  editorMode: z.enum(['normal', 'vim']).optional(),
  deferTools: z.boolean().optional(),
  hooks: z
    .partialRecord(z.enum(HOOK_EVENTS as [HookEvent, ...HookEvent[]]), z.array(hookEntrySchema))
    .optional(),
  sandbox: z
    .object({
      enabled: z.boolean().optional(),
      network: z.boolean().optional(),
      allowWrite: z.array(z.string()).optional(),
    })
    .optional(),
  lsp: z
    .record(
      z.string(),
      z.object({ command: z.array(z.string()).min(1), extensions: z.array(z.string()) }),
    )
    .optional(),
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

/** Parse and validate one settings file; `undefined` when it does not exist, throws on invalid content. */
export async function readSettingsFile(file: string): Promise<CoderSettings | undefined> {
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

/** Names of the project agent, skill and custom command files (empty lists when the directories do not exist). */
async function projectContentFiles(
  root: string,
): Promise<{ agents: string[]; skills: string[]; commands: string[]; styles: string[] }> {
  const agents = (await walkFiles(join(root, '.coder', 'agents'))).filter(
    (f) => f.endsWith('.md') && !f.includes('/'),
  )
  const skills = await walkFiles(join(root, '.coder', 'skills'))
  const commands = (await walkFiles(join(root, '.coder', 'commands'))).filter((f) =>
    f.endsWith('.md'),
  )
  const styles = (await walkFiles(join(root, '.coder', 'output-styles'))).filter((f) =>
    f.endsWith('.md'),
  )
  return { agents, skills, commands, styles }
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
  const { agents, skills, commands, styles } = await projectContentFiles(root)
  for (const f of styles) await feed(`style:${f}`, join(root, '.coder', 'output-styles', f))
  for (const f of agents) await feed(`agent:${f}`, join(root, '.coder', 'agents', f))
  for (const f of skills) await feed(`skill:${f}`, join(root, '.coder', 'skills', f))
  for (const f of commands) await feed(`command:${f}`, join(root, '.coder', 'commands', f))
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
  if (
    settings.hooks !== undefined &&
    Object.values(settings.hooks).some((list) => (list?.length ?? 0) > 0)
  ) {
    keys.push('hooks')
  }
  if (settings.statusLine !== undefined) keys.push('statusLine')
  if (settings.lsp !== undefined && Object.keys(settings.lsp).length > 0) keys.push('lsp')
  const sb = settings.sandbox
  if (
    sb !== undefined &&
    (sb.enabled === false || sb.network === true || (sb.allowWrite?.length ?? 0) > 0)
  ) {
    keys.push('sandbox')
  }
  return keys
}

/** Settings without the keys that need trust (`ask` and `deny` only tighten, so they stay). */
function withoutRisky(settings: CoderSettings): CoderSettings {
  const {
    mcpServers: _mcp,
    hooks: _hooks,
    statusLine: _status,
    lsp: _lsp,
    sandbox,
    permissions,
    ...rest
  } = settings
  const out: CoderSettings = { ...rest }
  if (sandbox !== undefined) {
    // only tightening survives: the sandbox may be turned on, never off, opened or widened
    const kept: NonNullable<CoderSettings['sandbox']> = {}
    if (sandbox.enabled === true) kept.enabled = true
    if (sandbox.network === false) kept.network = false
    if (Object.keys(kept).length > 0) out.sandbox = kept
  }
  if (permissions !== undefined) {
    const { defaultMode: _m, allow: _a, additionalDirectories: _d, ...safe } = permissions
    out.permissions = safe
  }
  return out
}

/** No project settings file: only project agents and skills can need trust. */
async function projectAgentsSkillsTrusted(
  root: string,
  userDir: string,
  untrusted: string[],
): Promise<boolean> {
  const { agents, skills, commands, styles } = await projectContentFiles(root)
  const risky = [
    ...(agents.length > 0 ? ['agents'] : []),
    ...(skills.length > 0 ? ['skills'] : []),
    ...(commands.length > 0 ? ['commands'] : []),
    ...(styles.length > 0 ? ['output-styles'] : []),
  ]
  if (risky.length === 0) return true
  if ((await readTrusted(userDir))[root] === (await projectHash(root))) return true
  untrusted.push(...risky)
  return false
}

/** One settings file that exists, trust applied (a project file without its risky keys when untrusted). */
export interface SettingsLayer {
  scope: 'user' | 'project' | 'local'
  file: string
  settings: CoderSettings
}

/** Read the three settings files in merge order and apply the project trust rules. */
async function readLayers(
  root: string,
  userDir: string,
  settingsFiles: CoderConfig['settingsFiles'],
): Promise<{ layers: SettingsLayer[]; untrusted: string[]; trusted: boolean }> {
  const layers: SettingsLayer[] = []
  const untrusted: string[] = []
  let trusted = true
  const scopes = [
    ['user', settingsFiles.user],
    ['project', settingsFiles.project],
    ['local', settingsFiles.local],
  ] as const
  for (const [scope, file] of scopes) {
    let settings = await readSettingsFile(file)
    if (!settings) {
      if (scope === 'project') trusted = await projectAgentsSkillsTrusted(root, userDir, untrusted)
      continue
    }
    if (scope === 'project') {
      const risky = riskyKeys(settings)
      const { agents, skills, commands, styles } = await projectContentFiles(root)
      if (styles.length > 0) risky.push('output-styles')
      if (agents.length > 0) risky.push('agents')
      if (skills.length > 0) risky.push('skills')
      if (commands.length > 0) risky.push('commands')
      if (risky.length > 0 && (await readTrusted(userDir))[root] !== (await projectHash(root))) {
        trusted = false
        untrusted.push(...risky)
        settings = withoutRisky(settings)
      }
    }
    layers.push({ scope, file, settings })
  }
  return { layers, untrusted, trusted }
}

/**
 * The settings files of a loaded config, in merge order (user, project, local), with the trust
 * rules applied. Used by the settings manager to show where a value comes from.
 */
export async function readSettingsLayers(
  config: Pick<CoderConfig, 'root' | 'userDir' | 'settingsFiles'>,
): Promise<SettingsLayer[]> {
  return (await readLayers(config.root, config.userDir, config.settingsFiles)).layers
}

/**
 * Merge settings objects (later wins). Scalars and `statusLine` are replaced; `hooks` lists are
 * concatenated per event; `sandbox`, `lsp` and `permissions` merge key by key (`allowWrite`
 * concatenated). `mcpServers` merges by server name.
 */
export function mergeSettings(list: readonly CoderSettings[]): CoderSettings {
  const out: CoderSettings = {}
  for (const s of list) {
    const { hooks, sandbox, lsp, permissions, mcpServers, ...scalars } = s
    Object.assign(out, scalars)
    if (hooks !== undefined) {
      const merged: NonNullable<CoderSettings['hooks']> = { ...out.hooks }
      for (const event of Object.keys(hooks) as HookEvent[]) {
        merged[event] = [...(merged[event] ?? []), ...(hooks[event] ?? [])]
      }
      out.hooks = merged
    }
    if (sandbox !== undefined) {
      out.sandbox = {
        ...out.sandbox,
        ...sandbox,
        ...(sandbox.allowWrite || out.sandbox?.allowWrite
          ? {
              allowWrite: dedupe([
                ...(out.sandbox?.allowWrite ?? []),
                ...(sandbox.allowWrite ?? []),
              ]),
            }
          : {}),
      }
    }
    if (lsp !== undefined) out.lsp = { ...out.lsp, ...lsp }
    if (permissions !== undefined) out.permissions = { ...out.permissions, ...permissions }
    if (mcpServers !== undefined) out.mcpServers = { ...out.mcpServers, ...mcpServers }
  }
  return out
}

/** What {@link loadConfig} returns. */
export type LoadedConfig = CoderConfig & {
  warnings: string[]
  /** A settings file set `contextWindow` (it then beats the models.dev catalog). */
  contextWindowExplicit: boolean
  /** The model came from a flag, a settings file or `CODER_MODEL` (a saved preference then loses). */
  modelExplicit: boolean
  /**
   * Merged settings of the three files (trust applied): the UI/runtime keys (`theme`,
   * `outputStyle`, `hooks`, `sandbox`, `lsp`, …). Refresh with {@link readSettingsLayers} +
   * {@link mergeSettings} after a settings write.
   */
  settings: CoderSettings
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
  let provider: ModelProvider | undefined
  let contextWindow: number | undefined
  let mode: PermissionMode | undefined
  let autoModel: string | undefined
  let autoEnabled = true
  const rules: PermissionRules = { allow: [], ask: [], deny: [] }
  const dirs: string[] = []
  const mcpServers: Record<string, unknown> = {}

  if (flags.trustProject) await trustProject({ root, userDir })
  const { layers, untrusted, trusted } = await readLayers(root, userDir, settingsFiles)

  for (const { file, settings } of layers) {
    model = settings.model ?? model
    provider = settings.provider ?? provider
    contextWindow = settings.contextWindow ?? contextWindow
    autoModel = settings.autoMode?.model ?? autoModel
    autoEnabled = settings.autoMode?.enabled ?? autoEnabled
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
    // `manual` is the name the footer shows for `default`
    const name = flags.permissionMode === 'manual' ? 'default' : flags.permissionMode
    const parsed = modeSchema.safeParse(name)
    if (!parsed.success) {
      throw new Error(
        `Invalid permission mode "${flags.permissionMode}". Use one of: manual, ${PERMISSION_MODES.join(', ')}`,
      )
    }
    mode = parsed.data
  }
  if (flags.dangerouslySkipPermissions) mode = 'bypassPermissions'
  const bypassInCycle =
    mode === 'bypassPermissions' || flags.allowDangerouslySkipPermissions === true
  if (process.env.CODER_AUTO_MODEL) autoModel = process.env.CODER_AUTO_MODEL
  if (!autoEnabled && mode === 'auto') {
    // like a managed `disableAutoMode`: start in manual mode instead
    warnings.push('auto mode is disabled by settings (autoMode.enabled); starting in manual mode.')
    mode = 'default'
  }
  if (flags.provider !== undefined) provider = parseProvider(flags.provider, '--provider')
  const resolvedProvider = provider ?? detectProvider(process.env)
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
  const explicitModel = flags.model ?? model ?? (process.env.CODER_MODEL || undefined)

  return {
    root,
    userDir,
    projectDataDir,
    settingsFiles,
    provider: resolvedProvider,
    model: explicitModel ?? DEFAULT_MODEL[resolvedProvider],
    contextWindow: contextWindow ?? 200_000,
    mode: mode ?? 'default',
    bypassInCycle,
    autoEnabled,
    ...(autoModel !== undefined ? { autoModel } : {}),
    rules: { allow: dedupe(rules.allow), ask: dedupe(rules.ask), deny: dedupe(rules.deny) },
    additionalDirectories,
    cliAgents,
    maxSteps: flags.maxSteps ?? 200,
    maxAgentDepth: 2,
    deferTools: mergeSettings(layers.map((l) => l.settings)).deferTools ?? true,
    mcpServers,
    print,
    continueLast: flags.continue ?? false,
    resume: flags.resume,
    untrusted,
    trusted,
    warnings,
    contextWindowExplicit: contextWindow !== undefined,
    modelExplicit: explicitModel !== undefined,
    settings: mergeSettings(layers.map((l) => l.settings)),
  }
}
