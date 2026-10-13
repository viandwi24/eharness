/**
 * The `code()` plugin (spec 28): `run_python` (and `install_packages`) over the files of the
 * virtual file system through a synchronised, disposable sandbox, and the `codeSandbox` service.
 *
 * Built only with the public core API (ADR-0008); runtime-neutral (Web APIs only).
 *
 * @see docs/specs/28-code-plugin.md
 */
import { tool } from 'ai'
import { z } from 'zod/v4'
import {
  definePlugin,
  errorText,
  type HarnessContext,
  HarnessError,
  type HarnessPlugin,
  normalizeRootedPath,
  type SessionContribution,
  type ToolRisk,
} from '../index.ts'
import {
  createEnvironments,
  type EnsuredEnvironment,
  EnvironmentError,
  formatPackages,
  type ParsedRequirement,
  type ProbeResult,
  parseRequirement,
} from './env.ts'
import { HOME_DIR, INLINE_SCRIPT_PATH } from './scripts.ts'
import {
  type CodeFileSystem,
  type CodeLimits,
  type CodeMount,
  type CodeSandbox,
  DEFAULT_CODE_IGNORE,
  DEFAULT_CODE_LIMITS,
  type FilePolicyLike,
  type SkippedFile,
  type SyncOutReport,
  sandboxPath,
  shellQuote,
  syncedSandbox,
} from './sync.ts'
import {
  INSTALL_PACKAGES_DESCRIPTION,
  RUN_PYTHON_DESCRIPTION,
  SANDBOX_DENIAL,
  SANDBOX_HINT,
} from './texts.ts'

/** Status reported by the `codeSandbox` service (spec 28 §7). */
export interface CodeSandboxStatus {
  python?: string
  driver: string
  isolated: boolean
  install: 'off' | 'allowlist' | 'any'
  extras: string[]
}

/** The `codeSandbox` service (spec 28 §7). */
export interface CodeSandboxService {
  status(): Promise<CodeSandboxStatus>
  /** Drop the manifest (the next sync-in is full). */
  reset(): void
}

declare module '../index.ts' {
  interface HarnessServices {
    /** Provided by `code()`: status of the code sandbox and a manifest reset. */
    codeSandbox: CodeSandboxService
  }
}

/** Name of the Python tool. */
export const RUN_PYTHON_TOOL = 'run_python'
/** Name of the package tool. */
export const INSTALL_PACKAGES_TOOL = 'install_packages'

/** Options of {@link code}. */
export interface CodeOptions {
  /** One sandbox per session. Its root (relative paths) is the session's work directory. */
  sandbox: CodeSandbox | ((ctx: HarnessContext) => CodeSandbox | Promise<CodeSandbox>)
  /** Prefixes of the virtual file system that are synced. Default `[{ virtual: '/work/' }]`. */
  mounts?: CodeMount[]
  python?: {
    /** Interpreter inside the sandbox when no environment is built. Default `'python3'`. */
    command?: string
    /** Build a base environment from these requirement lines (needs `envRoot` and `installer`). */
    requirements?: string[]
    /** Absolute directory inside the sandbox where environments are kept (outside the work directory). */
    envRoot?: string
  }
  packages?: {
    /** Default `'off'`. */
    install?: 'off' | 'allowlist' | 'any'
    /** For `'allowlist'`: names with an optional version specifier. */
    allow?: string[]
    /** Private index (`--index-url`). */
    indexUrl?: string
    /** Default `<first writable mount>.eharness/requirements.txt`. */
    listPath?: string
  }
  /** Sandbox used to build environments: network on, writes only under `envRoot`. */
  installer?: CodeSandbox | ((ctx: HarnessContext) => CodeSandbox | Promise<CodeSandbox>)
  limits?: Partial<CodeLimits>
  /** Default `'success'`: nothing is written back after a failed run. */
  writeBack?: 'success' | 'always'
  /** Default `true`; `false`: the files are already on the sandbox's disk (spec 28 §4.6). */
  sync?: boolean
  /** Glob patterns of paths never written back. Default {@link DEFAULT_CODE_IGNORE}. */
  ignore?: string[]
  /** Application authority per path. Default: everything allowed. */
  access?: (
    path: string,
    op: 'read' | 'write' | 'delete',
    ctx: HarnessContext,
  ) => boolean | Promise<boolean>
  /** Refuse to run when the sandbox does not declare isolation. Default `false`. */
  requireIsolation?: boolean
  /** `metadata.risk` of `run_python`. Default `'external'`. */
  risk?: ToolRisk
  /** `metadata.risk` of `install_packages`. Default `'external'`. */
  installRisk?: ToolRisk
}

function invalid(message: string): never {
  throw new HarnessError('EH_CONFIG_INVALID', `code: ${message}`, { details: { plugin: 'code' } })
}

function validMount(mount: CodeMount): boolean {
  const v = mount?.virtual
  if (typeof v !== 'string' || !v.startsWith('/') || !v.endsWith('/')) return false
  const n = normalizeRootedPath(v)
  if (!n.ok) return false
  const dir = n.path === '/' ? '/' : `${n.path}/`
  return dir === v && v !== '/.eh-code/' && !v.startsWith('/.eh-code/')
}

/** Isolation of a sandbox (spec 28 §6): `state()` of a local sandbox, or the `isolation` field. */
function isolationOf(sandbox: CodeSandbox): { isolated: boolean; label: string } {
  const state = (sandbox as { state?: () => { enabled: boolean; network?: boolean } }).state
  if (typeof state === 'function') {
    const s = state.call(sandbox)
    const network = s.network === true ? 'network on' : 'network off'
    return {
      isolated: s.enabled && s.network !== true,
      label: s.enabled
        ? `local sandbox with OS isolation, ${network}`
        : 'local sandbox without OS isolation',
    }
  }
  if (sandbox.isolation !== undefined) return sandbox.isolation
  return { isolated: false, label: 'the driver does not declare isolation' }
}

function osSandboxOn(sandbox: CodeSandbox): boolean {
  const state = (sandbox as { state?: () => { enabled: boolean } }).state
  return typeof state === 'function' && state.call(sandbox).enabled
}

function list(items: readonly string[], max = 20): string {
  const shown = items.slice(0, max).join(', ')
  return items.length > max ? `${shown}, … and ${items.length - max} more` : shown
}

function skipped(items: readonly SkippedFile[]): string[] {
  return items.map((s) => `${s.path} (${s.reason})`)
}

function tailOf(text: string, max: number): string {
  const t = text.trim()
  return t.length > max ? t.slice(t.length - max) : t
}

/**
 * The code plugin: `run_python` over the files of the virtual file system, optional
 * `install_packages`, service `codeSandbox`. Needs the `fs` service (put it after `filesystem()`).
 *
 * @example
 * ```ts
 * plugins: [filesystem({ fs }), code({ sandbox: () => localSandbox({ root: scratch }) })]
 * ```
 * @see docs/specs/28-code-plugin.md
 */
export function code(options: CodeOptions): HarnessPlugin<'code'> {
  if (typeof options !== 'object' || options === null) invalid('expected an options object.')
  if (options.sandbox === undefined) invalid('`sandbox` is required.')
  const mounts: CodeMount[] = options.mounts ?? [{ virtual: '/work/' }]
  if (mounts.length === 0) invalid('`mounts` may not be empty.')
  for (const m of mounts) {
    if (!validMount(m)) {
      invalid(
        `mount ${JSON.stringify(m?.virtual)} must be a directory prefix that starts and ends with "/".`,
      )
    }
  }
  for (const a of mounts) {
    for (const b of mounts) {
      if (a !== b && (a.virtual.startsWith(b.virtual) || b.virtual.startsWith(a.virtual))) {
        invalid(`mounts ${a.virtual} and ${b.virtual} overlap.`)
      }
    }
  }
  const limits: CodeLimits = { ...DEFAULT_CODE_LIMITS, ...options.limits }
  for (const [name, value] of Object.entries(limits)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      invalid(`limit \`${name}\` must be a positive number.`)
    }
  }
  const install = options.packages?.install ?? 'off'
  if (install !== 'off' && install !== 'allowlist' && install !== 'any') {
    invalid('`packages.install` must be "off", "allowlist" or "any".')
  }
  const python = options.python?.command ?? 'python3'
  const requirements = options.python?.requirements ?? []
  const envRoot = options.python?.envRoot
  if (install !== 'off' && options.installer === undefined) {
    invalid('`packages.install` needs an `installer`.')
  }
  if ((install !== 'off' || requirements.length > 0) && envRoot === undefined) {
    invalid('building environments needs `python.envRoot`.')
  }
  if (requirements.length > 0 && options.installer === undefined) {
    invalid('`python.requirements` needs an `installer`.')
  }
  const allowEntries: ParsedRequirement[] = []
  if (install === 'allowlist') {
    if (options.packages?.allow === undefined || options.packages.allow.length === 0) {
      invalid('`packages.install: "allowlist"` needs `packages.allow`.')
    }
    for (const entry of options.packages.allow) {
      const parsed = parseRequirement(entry)
      if (!parsed.ok)
        invalid(
          `\`packages.allow\` entry ${JSON.stringify(entry)} is not a package name with an optional version.`,
        )
      allowEntries.push(parsed.requirement)
    }
  }
  const firstWritable = mounts.find((m) => m.readonly !== true)
  const listPath =
    options.packages?.listPath ??
    (firstWritable ? `${firstWritable.virtual}.eharness/requirements.txt` : undefined)
  if (install !== 'off' && listPath === undefined) {
    invalid('`packages.install` needs a writable mount or `packages.listPath`.')
  }
  const writeBack = options.writeBack ?? 'success'
  const sync = options.sync ?? true
  const risk = options.risk ?? 'external'
  const installRisk = options.installRisk ?? 'external'
  const mountText = mounts
    .map((m) => `${m.virtual} (${m.readonly === true ? 'read-only' : 'read/write'})`)
    .join(', ')
  const probeCache = new Map<string, ProbeResult>()

  const allowCheck = (req: ParsedRequirement): string | undefined => {
    if (install !== 'allowlist') return undefined
    const ok = allowEntries.some(
      (a) => a.name === req.name && (a.specifier === '' || a.specifier === req.specifier),
    )
    return ok ? undefined : `${req.name} is not on the list of allowed packages.`
  }
  const validateLine = (line: string): string | undefined => {
    const parsed = parseRequirement(line)
    if (!parsed.ok) return `"${line}" is not a package name with an optional version.`
    return allowCheck(parsed.requirement)
  }

  return definePlugin({
    name: 'code',
    requires: ['fs'],
    provides: ['codeSandbox'],
    session: async (ctx): Promise<SessionContribution> => {
      const context = ctx as unknown as HarnessContext
      const sandbox = (
        typeof options.sandbox === 'function' ? await options.sandbox(context) : options.sandbox
      ) as CodeSandbox
      const installer =
        typeof options.installer === 'function'
          ? await options.installer(context)
          : options.installer
      const services = ctx.services as unknown as {
        fs: CodeFileSystem
        filePolicy?: FilePolicyLike
      }
      const fs = (): CodeFileSystem => services.fs
      let policy: FilePolicyLike | undefined
      try {
        policy = services.filePolicy
      } catch {
        policy = undefined // no filePolicy service: the file tools' policy is not shared
      }
      const iso = isolationOf(sandbox)
      let currentPython = python
      const userAccess = options.access
      const access = async (path: string, op: 'read' | 'write' | 'delete'): Promise<boolean> => {
        if (path === listPath && op !== 'read') return false
        return userAccess === undefined ? true : await userAccess(path, op, context)
      }
      const envs = createEnvironments(
        {
          command: python,
          requirements,
          ...(envRoot === undefined ? {} : { envRoot }),
          ...(installer === undefined ? {} : { installer }),
          ...(options.packages?.indexUrl === undefined
            ? {}
            : { indexUrl: options.packages.indexUrl }),
          runtime: sandbox,
          validate: validateLine,
        },
        probeCache,
      )
      const bridge = syncedSandbox({
        fs: fs(),
        sandbox,
        mounts,
        limits,
        ignore: options.ignore ?? [...DEFAULT_CODE_IGNORE],
        ...(policy === undefined ? {} : { policy }),
        access,
        listCommand: () => currentPython,
      })

      async function readExtras(): Promise<string[]> {
        if (listPath === undefined) return []
        const file = await fs().read(listPath)
        if (file === null) return []
        const lines = file.content
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l !== '' && !l.startsWith('#'))
          .map((l) => {
            const parsed = parseRequirement(l)
            return parsed.ok ? parsed.requirement.line : l
          })
        return [...new Set(lines)].sort()
      }

      if (install === 'any' && listPath !== undefined && policy?.isReadonly(listPath) !== true) {
        ctx.log.warn(
          `code: packages.install is "any" and ${listPath} is not read-only; list it in the filesystem plugin's readonlyPrefixes.`,
        )
      }

      // Description: the environment line (computed once per session, probe cached per environment).
      const ready = await envs.peek()
      const probed = ready === undefined ? undefined : await envs.probe(ready)
      const environmentLine =
        probed === undefined
          ? `Python environment: ${python} (packages unknown).`
          : `Python ${probed.version}. Installed packages: ${formatPackages(probed.packages)}.`
      const description = `${RUN_PYTHON_DESCRIPTION.replace('{mounts}', mountText)
        .replace('{timeout}', String(Math.round(limits.timeoutMs / 1000)))
        .replace(
          '{maxTimeout}',
          String(Math.round(limits.maxTimeoutMs / 1000)),
        )}\n\n${environmentLine}`

      const stopped = (error: unknown): string =>
        `ERROR: the sandbox stopped during the run; nothing was saved. (${errorText(error)})`

      async function runPython(
        input: { file?: string; code?: string; args?: string[]; timeoutSeconds?: number },
        abortSignal: AbortSignal | undefined,
      ): Promise<string> {
        if ((input.file === undefined) === (input.code === undefined)) {
          return 'ERROR: give either file or code.'
        }
        let virtual: string | undefined
        if (input.file !== undefined) {
          const n = normalizeRootedPath(input.file)
          if (!n.ok) return `ERROR: ${n.error}.`
          virtual = n.path
          if (!mounts.some((m) => virtual?.startsWith(m.virtual))) {
            return `ERROR: ${virtual} is not under a synced folder (${mounts.map((m) => m.virtual).join(', ')}).`
          }
        }
        if (options.requireIsolation === true && !iso.isolated) {
          return `ERROR: running code needs an isolated sandbox, and this one is not (${iso.label}).`
        }
        const timeout = Math.min(
          input.timeoutSeconds === undefined
            ? limits.timeoutMs
            : Math.max(1, input.timeoutSeconds) * 1000,
          limits.maxTimeoutMs,
        )
        return await bridge.exclusive(async () => {
          let env: EnsuredEnvironment
          try {
            env = await envs.ensure(await readExtras())
          } catch (error) {
            const text = error instanceof EnvironmentError ? error.message : errorText(error)
            return `ERROR: rebuilding the package environment failed: ${tailOf(text, 2000)}`
          }
          currentPython = env.python
          let notCopied: SkippedFile[] = []
          let scriptPath: string
          try {
            if (sync) notCopied = (await bridge.syncIn()).notCopied
            if (virtual !== undefined) {
              scriptPath = sandboxPath(virtual)
              const exists = sync
                ? bridge.manifest().has(virtual)
                : (await sandbox.readTextFile({ path: scriptPath })) !== null
              if (!exists) return `ERROR: ${virtual} does not exist.`
            } else {
              scriptPath = INLINE_SCRIPT_PATH
              await sandbox.writeTextFile({ path: scriptPath, content: input.code ?? '' })
            }
          } catch (error) {
            return stopped(error)
          }
          const command = [
            shellQuote(env.python),
            '-E -s -B -u',
            shellQuote(scriptPath),
            ...(input.args ?? []).map(shellQuote),
          ].join(' ')
          const result = await bridge.run(command, {
            env: {
              PYTHONDONTWRITEBYTECODE: '1',
              MPLBACKEND: 'Agg',
              PYTHONUNBUFFERED: '1',
              HOME: HOME_DIR,
            },
            timeoutMs: timeout,
            ...(abortSignal === undefined ? {} : { signal: abortSignal }),
            maxOutputChars: limits.maxOutputChars,
          })
          if (result.failure !== undefined) {
            bridge.reset()
            return stopped(result.failure)
          }
          const succeeded = result.exitCode === 0
          let report: SyncOutReport = { saved: [], deleted: [], notSaved: [] }
          if (sync) {
            try {
              report = await bridge.syncOut(succeeded || writeBack === 'always')
            } catch (error) {
              bridge.reset()
              return stopped(error)
            }
          }
          const lines: string[] = []
          if (env.rebuilt !== undefined) {
            lines.push(
              `Rebuilt the package environment (${env.rebuilt.packages} packages, ${Math.round(env.rebuilt.seconds)}s).`,
            )
          }
          const body = [result.output.trimEnd()]
          const missing = /ModuleNotFoundError: No module named '([^']+)'/.exec(result.output)
          if (missing?.[1] !== undefined) {
            const name = missing[1].split('.')[0]
            if (install === 'off') {
              const info = await envs.probe(env)
              body.push(
                `(${name} is not installed. Installed packages: ${info === undefined ? 'unknown' : formatPackages(info.packages)}. Use the standard library or one of them.)`,
              )
            } else {
              body.push(`(${name} is not installed. Use install_packages to add it.)`)
            }
          }
          const absolute = /FileNotFoundError:[^\n]*?['"](\/[^'"\n]+)['"]/.exec(result.output)
          if (
            absolute?.[1] !== undefined &&
            mounts.some((m) => absolute[1]?.startsWith(m.virtual))
          ) {
            body.push(`(Paths are relative to the sandbox root: use ${absolute[1].slice(1)}.)`)
          }
          if (osSandboxOn(sandbox) && SANDBOX_DENIAL.test(result.output)) body.push(SANDBOX_HINT)
          const text = body.filter((b) => b !== '').join('\n')
          if (text !== '') lines.push(text)
          if (result.timedOut) lines.push(`(timed out after ${Math.round(timeout / 1000)}s)`)
          else if (result.aborted) lines.push(`(aborted after ${result.seconds.toFixed(1)}s)`)
          else lines.push(`Exit code ${result.exitCode} · ${result.seconds.toFixed(1)}s`)
          if (report.saved.length > 0) lines.push(`Saved: ${list(report.saved)}`)
          if (report.deleted.length > 0) lines.push(`Deleted: ${list(report.deleted)}`)
          if (report.failedRun !== undefined) {
            lines.push(`Not saved (the run failed): ${report.failedRun} changed files.`)
          } else if (report.notSaved.length > 0) {
            lines.push(`Not saved: ${list(skipped(report.notSaved))}`)
          }
          if (notCopied.length > 0) lines.push(`Not copied in: ${list(skipped(notCopied))}`)
          return lines.join('\n')
        })
      }

      async function installPackages(input: { packages: string[] }): Promise<string> {
        const wanted: ParsedRequirement[] = []
        for (const line of input.packages) {
          const parsed = parseRequirement(line)
          if (!parsed.ok) return `ERROR: "${line}" is not a package name with an optional version.`
          wanted.push(parsed.requirement)
        }
        for (const req of wanted) {
          const problem = allowCheck(req)
          if (problem !== undefined) return `REJECTED: ${problem}`
        }
        return await bridge.exclusive(async () => {
          const started = Date.now()
          const merged = new Map<string, string>()
          for (const line of await readExtras()) {
            const parsed = parseRequirement(line)
            merged.set(parsed.ok ? parsed.requirement.name : line, line)
          }
          for (const req of wanted) merged.set(req.name, req.line)
          const lines = [...merged.values()].sort()
          let env: EnsuredEnvironment
          try {
            env = await envs.ensure(lines)
          } catch (error) {
            const text = error instanceof EnvironmentError ? error.message : errorText(error)
            return `ERROR: installing failed: ${tailOf(text, 2000)}`
          }
          currentPython = env.python
          try {
            if (listPath !== undefined) {
              const written = await fs().write(listPath, `${lines.join('\n')}\n`)
              if (!written.ok) return `ERROR: installing failed: could not save ${listPath}.`
            }
          } catch (error) {
            return `ERROR: installing failed: ${errorText(error)}`
          }
          const info = await envs.probe(env)
          const versions = new Map<string, string>()
          for (const [name, version] of info?.packages ?? []) {
            versions.set(name.toLowerCase().replace(/[-_.]+/g, '-'), version)
          }
          const names = wanted.map((req) => {
            const v = versions.get(req.name)
            return v === undefined ? req.name : `${req.name} ${v.split('.').slice(0, 2).join('.')}`
          })
          return `Installed: ${names.join(', ')} (${Math.round((Date.now() - started) / 1000)}s). They can be imported in the next run_python call.`
        })
      }

      const tools: Record<string, unknown> = {
        [RUN_PYTHON_TOOL]: tool({
          description,
          inputSchema: z.object({
            file: z
              .string()
              .optional()
              .describe('Virtual path of the script to run, for example /work/analyze.py.'),
            code: z
              .string()
              .optional()
              .describe('Inline Python code (not saved). Give file or code.'),
            args: z.array(z.string()).optional().describe('Command-line arguments of the script.'),
            timeoutSeconds: z.number().optional().describe('Timeout in seconds.'),
          }),
          metadata: { risk },
          execute: async (
            input: { file?: string; code?: string; args?: string[]; timeoutSeconds?: number },
            { abortSignal }: { abortSignal?: AbortSignal },
          ): Promise<string> => {
            try {
              return await runPython(input, abortSignal)
            } catch (error) {
              return stopped(error)
            }
          },
        } as never),
      }
      if (install !== 'off') {
        tools[INSTALL_PACKAGES_TOOL] = tool({
          description: INSTALL_PACKAGES_DESCRIPTION,
          inputSchema: z.object({
            packages: z.array(z.string()).min(1).max(20),
          }),
          metadata: { risk: installRisk },
          execute: async (input: { packages: string[] }): Promise<string> => {
            try {
              return await installPackages(input)
            } catch (error) {
              return `ERROR: installing failed: ${errorText(error)}`
            }
          },
        } as never)
      }

      return {
        services: {
          codeSandbox: {
            status: async (): Promise<CodeSandboxStatus> => {
              const env = await envs.peek()
              const info = env === undefined ? undefined : await envs.probe(env)
              let extras: string[] = []
              try {
                extras = await readExtras()
              } catch {
                extras = []
              }
              return {
                ...(info === undefined ? {} : { python: info.version }),
                driver: sandbox.isolation?.label ?? iso.label,
                isolated: iso.isolated,
                install,
                extras,
              }
            },
            reset: () => bridge.reset(),
          },
        },
        tools: tools as never,
        dispose: async (): Promise<void> => {
          try {
            await sandbox.dispose?.()
          } catch (error) {
            ctx.log.warn(`code: disposing the sandbox failed: ${errorText(error)}`)
          }
        },
      }
    },
  })
}
