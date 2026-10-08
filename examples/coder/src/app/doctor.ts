/** `/doctor`: environment and configuration checks. Every dependency is injectable for tests. */
import { access, constants, mkdir } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import type { CoderConfig, CoderSettings, DoctorCheck, ModelOption } from '../contracts.ts'
import { detectOsSandbox } from '../shell/os-sandbox.ts'
import { readSettingsFile } from './config.ts'
import { KEY_ENV, missingKeyError } from './provider.ts'

/** Inputs of {@link runDoctor}. */
export interface DoctorDeps {
  config: Pick<
    CoderConfig,
    | 'root'
    | 'userDir'
    | 'settingsFiles'
    | 'provider'
    | 'model'
    | 'trusted'
    | 'untrusted'
    | 'mcpServers'
  >
  /** Merged settings (`LoadedConfig.settings`), for `sandbox` and `lsp`. */
  settings?: CoderSettings
  /** The model picker list; a rejection or an empty list means "catalog unavailable". */
  models?(): Promise<ModelOption[]>
  /** Default: `process.env`. */
  env?: Record<string, string | undefined>
  /** Resolve an executable on PATH. Default: scan `env.PATH`. */
  which?(command: string): Promise<string | undefined>
  /** Default: `Bun.version`, else `process.versions.bun`. */
  bunVersion?: string
  /** Default: `detectOsSandbox()`. */
  osSandbox?(): { kind: 'seatbelt' | 'bubblewrap' | 'none' }
  /** Default: the stdout of this process. */
  terminal?: { columns?: number; rows?: number; isTTY?: boolean }
  platform?: NodeJS.Platform
}

async function scanPath(
  command: string,
  env: Record<string, string | undefined>,
): Promise<string | undefined> {
  if (command.includes('/')) {
    return await access(command, constants.X_OK).then(
      () => command,
      () => undefined,
    )
  }
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    const file = join(dir, command)
    if (
      await access(file, constants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return file
  }
  return undefined
}

/** Run every check; never rejects. */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorCheck[]> {
  const { config } = deps
  const env = deps.env ?? process.env
  const which = deps.which ?? ((c: string) => scanPath(c, env))
  const platform = deps.platform ?? process.platform
  const checks: DoctorCheck[] = []
  const add = (name: string, status: DoctorCheck['status'], detail: string): void => {
    checks.push({ name, status, detail })
  }
  const safe = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn()
    } catch (error) {
      add(name, 'error', error instanceof Error ? error.message : String(error))
    }
  }

  await safe('Runtime', async () => {
    const bun =
      deps.bunVersion ??
      (globalThis as { Bun?: { version?: string } }).Bun?.version ??
      process.versions.bun
    if (bun === undefined)
      add('Runtime', 'warn', `Node ${process.versions.node} (Bun is the supported runtime)`)
    else {
      const [major = 0, minor = 0] = bun.split('.').map((n) => Number.parseInt(n, 10))
      add(
        'Runtime',
        major > 1 || (major === 1 && minor >= 2) ? 'ok' : 'warn',
        `Bun ${bun}${major > 1 || (major === 1 && minor >= 2) ? '' : ' (1.2 or newer recommended)'}`,
      )
    }
  })

  await safe('Provider key', async () => {
    const problem = missingKeyError(config.provider, env)
    if (problem === undefined)
      add('Provider key', 'ok', `${KEY_ENV[config.provider]} is set (${config.provider})`)
    else add('Provider key', 'error', problem)
  })

  await safe('Model', async () => {
    if (deps.models === undefined)
      return add('Model', 'ok', `${config.model} (catalog not checked)`)
    let list: ModelOption[] = []
    try {
      list = await deps.models()
    } catch {
      // handled below
    }
    if (list.length === 0)
      return add('Model', 'warn', `${config.model}: model catalog unavailable (offline?)`)
    const found = list.some((m) => m.id === config.model)
    add(
      'Model',
      found ? 'ok' : 'warn',
      found
        ? `${config.model} is in the catalog`
        : `${config.model} is not in the ${config.provider} catalog`,
    )
  })

  for (const [name, command, status, hint] of [
    ['git', 'git', 'warn', 'needed for /diff and branch names'],
    ['ripgrep', 'rg', 'warn', 'faster search; grep falls back to a built-in search'],
  ] as const) {
    const path = await which(command).catch(() => undefined)
    add(name, path ? 'ok' : status, path ?? `\`${command}\` not found on PATH (${hint})`)
  }

  const editor = env.VISUAL || env.EDITOR
  add(
    'Editor',
    editor ? 'ok' : 'warn',
    editor ? `$EDITOR = ${editor}` : '$EDITOR is not set (needed for Ctrl+G external editing)',
  )

  await safe('Clipboard', async () => {
    const candidates =
      platform === 'darwin'
        ? ['pbcopy']
        : platform === 'win32'
          ? ['clip']
          : ['wl-copy', 'xclip', 'xsel']
    for (const c of candidates) {
      const path = await which(c).catch(() => undefined)
      if (path) return add('Clipboard', 'ok', `${c} (${path})`)
    }
    add(
      'Clipboard',
      'warn',
      `none of ${candidates.join(', ')} found; /copy prints the text instead`,
    )
  })

  await safe('Sandbox', async () => {
    const kind = (deps.osSandbox ?? detectOsSandbox)().kind
    const wanted = deps.settings?.sandbox?.enabled === true
    if (kind === 'none') {
      add(
        'Sandbox',
        wanted ? 'warn' : 'ok',
        wanted
          ? `sandbox.enabled is on but ${platform === 'darwin' ? 'sandbox-exec' : 'bwrap'} is not available: commands run unsandboxed`
          : `no OS sandbox tool (${platform === 'darwin' ? 'sandbox-exec' : 'bwrap'}); sandboxing is unavailable`,
      )
    } else {
      add(
        'Sandbox',
        'ok',
        `${kind} available${wanted ? ', enabled' : ', disabled (sandbox.enabled)'}`,
      )
    }
  })

  await safe('Settings files', async () => {
    const problems: string[] = []
    let found = 0
    for (const file of Object.values(config.settingsFiles)) {
      try {
        if ((await readSettingsFile(file)) !== undefined) found++
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error))
      }
    }
    if (problems.length > 0) add('Settings files', 'error', problems.join('; '))
    else add('Settings files', 'ok', `${found} of 3 settings files present, all valid`)
  })

  add(
    'Project trust',
    config.trusted ? 'ok' : 'warn',
    config.trusted
      ? 'project content is trusted (or has none)'
      : `ignored until trusted: ${config.untrusted.join(', ')} (run with --trust-project to accept)`,
  )

  const mcp = Object.keys(config.mcpServers)
  add(
    'MCP servers',
    'ok',
    mcp.length === 0 ? 'none configured' : `${mcp.length} configured: ${mcp.join(', ')}`,
  )

  await safe('LSP', async () => {
    const lsp = Object.entries(deps.settings?.lsp ?? {})
    if (lsp.length === 0) return add('LSP', 'ok', 'none configured')
    const missing: string[] = []
    for (const [name, def] of lsp) {
      const bin = def.command[0]
      if (bin === undefined || !(await which(bin).catch(() => undefined))) {
        missing.push(`${name} (${bin ?? 'no command'})`)
      }
    }
    add(
      'LSP',
      missing.length === 0 ? 'ok' : 'warn',
      missing.length === 0
        ? `${lsp.length} configured, all commands found`
        : `command not found: ${missing.join(', ')}`,
    )
  })

  await safe('Data directory', async () => {
    await mkdir(config.userDir, { recursive: true })
    await access(config.userDir, constants.W_OK)
    add('Data directory', 'ok', `${config.userDir} is writable`)
  })

  const t = deps.terminal ?? {
    columns: process.stdout.columns,
    rows: process.stdout.rows,
    isTTY: process.stdout.isTTY,
  }
  const size =
    t.columns !== undefined && t.rows !== undefined ? `${t.columns}x${t.rows}` : 'unknown size'
  const colors = env.NO_COLOR
    ? 'colors disabled (NO_COLOR)'
    : env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit'
      ? 'truecolor'
      : /256/.test(env.TERM ?? '')
        ? '256 colors'
        : env.TERM && env.TERM !== 'dumb'
          ? 'basic colors'
          : 'no color support detected'
  const narrow = t.columns !== undefined && t.columns < 60
  add(
    'Terminal',
    t.isTTY === false || narrow || colors === 'no color support detected' ? 'warn' : 'ok',
    `${t.isTTY === false ? 'not a TTY, ' : ''}${size}, ${colors}${narrow ? ' (narrow: 60+ columns recommended)' : ''}`,
  )
  return checks
}
