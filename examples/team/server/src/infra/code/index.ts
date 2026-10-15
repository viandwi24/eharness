/**
 * The code sandbox of the Files & Sandbox connector (`eharness/code`, docs/specs/28-code-plugin.md):
 * configuration from the environment, the sandbox of each session (a local scratch directory under
 * an OS sandbox; a remote driver plugs into `createCodeSandbox`) and the status the Settings page shows. Nothing here is
 * stored: the library (database) holds every file, the sandbox is a disposable cache (plan P44 D11).
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { HarnessPlugin } from 'eharness'
import { type CodeSandbox, code } from 'eharness/code'
import {
  localSandbox,
  type OsSandboxProbe,
  probeOsSandbox,
  removeStaleScratch,
  scratchSandbox,
} from 'eharness/shell'
import type { ProgramStore } from '../../app/ports.ts'
import type { CodeDriver, CodeInstall, CodeSandboxInfo } from '../../domain/code-sandbox.ts'
import { programPathAccess } from '../bigdata/authority.ts'

export type { CodeDriver, CodeInstall, CodeSandboxInfo }

export interface CodeConfig {
  driver: CodeDriver
  /** Interpreter (`local`; inside the container the image's `python3`). */
  python: string
  install: CodeInstall
  allow: string[]
  /** Where package environments live (`local` with installs or a requirements file). */
  envRoot: string
  /** Requirements file of the base environment; none = use the interpreter as it is. */
  requirements?: string
  /** Parent of the per-session scratch directories (`local`). */
  scratchRoot: string
  /** The server's data directory: denied for reading to the code (`local`). */
  dataDir: string
}

type Env = Record<string, string | undefined>

function onPath(name: string, env: Env): string | undefined {
  for (const dir of (env.PATH ?? '').split(':')) {
    if (dir !== '' && existsSync(join(dir, name))) return join(dir, name)
  }
  return undefined
}

/** `TEAM_CODE_*` of the environment (docs: `main.ts` header, README). */
export function codeConfigFromEnv(env: Env, dbFile: string): CodeConfig {
  const python = env.TEAM_CODE_PYTHON?.trim() || 'python3'
  const requested = env.TEAM_CODE_DRIVER?.trim()
  const found = isAbsolute(python) ? existsSync(python) : onPath(python, env) !== undefined
  const driver: CodeDriver =
    requested === 'off' || requested === 'local' ? requested : found ? 'local' : 'off'
  const requestedInstall = env.TEAM_CODE_INSTALL?.trim()
  const install: CodeInstall =
    driver !== 'local'
      ? 'off'
      : requestedInstall === 'allowlist' || requestedInstall === 'any'
        ? requestedInstall
        : 'off'
  const dataDir = resolve(dbFile === ':memory:' ? join(tmpdir(), 'eharness-team') : dirname(dbFile))
  const requirements = env.TEAM_CODE_REQUIREMENTS?.trim()
  return {
    driver,
    python,
    install,
    allow: (env.TEAM_CODE_ALLOW ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
    envRoot: resolve(env.TEAM_CODE_ENV_ROOT?.trim() || join(dataDir, 'python-envs')),
    ...(requirements === undefined || requirements === ''
      ? {}
      : { requirements: resolve(requirements) }),
    scratchRoot: join(dataDir, 'code-scratch'),
    dataDir,
  }
}

export interface CodeRuntime {
  readonly config: CodeConfig
  /** `files.code` option of the built-in connector; undefined = no code capabilities. */
  readonly filesOption: { install: boolean } | undefined
  /** The plugin of one session of a files connection with these tools on. */
  plugin(input: { tools: readonly string[] }): HarnessPlugin
  /** The plugin of the Remote sandbox connector (same mounts and path authority). */
  remotePlugin(input: {
    sandbox: () => Promise<CodeSandbox>
    pythonCommand: string
    tools: readonly string[]
  }): HarnessPlugin
  info(): Promise<CodeSandboxInfo>
  /** Remove scratch directories left by a crashed server (`local`). Call at start. */
  start(): Promise<void>
}

function pythonVersion(command: string): Promise<string | null> {
  return new Promise((ok) => {
    execFile(command, ['--version'], { timeout: 5000 }, (error, stdout, stderr) => {
      if (error !== null) return ok(null)
      const m = /Python\s+(\S+)/.exec(`${stdout}${stderr}`)
      ok(m?.[1] ?? null)
    })
  })
}

function parseRequirements(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.replace(/\s+#.*$/, '').trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
}

/** Virtual folders synced into the sandbox: the library (read/write) and uploads (read-only). */
export const CODE_MOUNTS = [
  { virtual: '/library/' },
  { virtual: '/uploads/', readonly: true },
] as const
/** The stored requirement list: never editable with the file tools. */
export const CODE_LIST_PATH = '/library/.eharness/requirements.txt'

/**
 * The path authority of `code()` (local and remote alike): a program run works under the program's
 * authority, otherwise the connection's file capabilities decide.
 */
export function codeAccess(
  programs: () => Pick<ProgramStore, 'get'> | undefined,
  tools: readonly string[],
): NonNullable<Parameters<typeof code>[0]['access']> {
  let access: ReturnType<typeof programPathAccess> | undefined
  const may = (tool: string): boolean => tools.includes(tool)
  return (path, op, ctx) => {
    access ??= programPathAccess(programs() ?? { get: () => undefined })
    // a program run (or its rehearsal) works under the program's authority
    const authority = access(ctx.session.id)
    if (authority !== undefined) {
      return op === 'read' ? authority.canRead(path) : authority.canWrite(path)
    }
    // otherwise the connection's file capabilities decide
    if (op === 'read') return may('read_file')
    if (op === 'write') return may('write_file') || may('edit_file')
    return may('delete_file')
  }
}

/**
 * `code()` over a remote sandbox server (the Remote sandbox connector, plan P44 D13): one session
 * on the server per chat session (disposed at close), the server's own interpreter, isolation
 * required, no package installs (packages live in the server image).
 */
export function remoteCodePlugin(input: {
  sandbox: () => Promise<CodeSandbox>
  pythonCommand: string
  tools: readonly string[]
  programs: () => Pick<ProgramStore, 'get'> | undefined
}): HarnessPlugin {
  return code({
    sandbox: () => input.sandbox(),
    mounts: [...CODE_MOUNTS],
    python: { command: input.pythonCommand },
    packages: { install: 'off', listPath: CODE_LIST_PATH },
    requireIsolation: true,
    access: codeAccess(input.programs, input.tools),
  })
}

/** Why code does not run isolated on this host, in words an operator can act on. */
export function notIsolatedWhy(probe: OsSandboxProbe): string {
  if (probe.ok) return 'isolated'
  if (probe.kind === 'bubblewrap') {
    return `bubblewrap is installed but this container does not allow user namespaces: run the container with seccomp/apparmor unconfined (or --cap-add SYS_ADMIN), or connect the Remote sandbox${probe.reason === undefined ? '' : ` (${probe.reason})`}`
  }
  if (probe.kind === 'seatbelt') {
    return `sandbox-exec does not work here${probe.reason === undefined ? '' : ` (${probe.reason})`}`
  }
  return 'no OS sandbox on this host'
}

export function createCodeRuntime(
  config: CodeConfig,
  deps: {
    programs: () => Pick<ProgramStore, 'get'> | undefined
    warn?: (message: string) => void
    /** The OS sandbox check (default `probeOsSandbox`); tests inject a result. */
    probe?: () => Promise<OsSandboxProbe>
  },
): CodeRuntime {
  const warn = deps.warn ?? ((m) => console.warn(`team: ${m}`))
  const on = config.driver !== 'off'
  const requirements =
    config.driver === 'local' && config.requirements !== undefined
      ? parseRequirements(config.requirements)
      : []
  const building =
    config.driver === 'local' && (config.install !== 'off' || requirements.length > 0)
  // The OS sandbox is probed once (a trivial command through it): bubblewrap is often installed
  // in a container that does not allow user namespaces, and then every run would fail. When it
  // does not work, code runs like on a host without one (not isolated), and Settings says why.
  let probing: Promise<OsSandboxProbe> | undefined
  const probe = (): Promise<OsSandboxProbe> => {
    probing ??= (deps.probe ?? (() => probeOsSandbox()))().catch(
      (error): OsSandboxProbe => ({ kind: 'none', ok: false, reason: String(error) }),
    )
    return probing
  }
  let installer: ReturnType<typeof localSandbox> | undefined

  // the interpreter may live under the home directory (pyenv, a virtualenv): reading it stays allowed
  const interpreterDirs = (): string[] => {
    if (!isAbsolute(config.python)) return []
    return [dirname(dirname(config.python))]
  }

  /**
   * The sandbox of one session. A remote driver plugs in here (`driver: 'remote'`): any
   * `CodeSandbox` works, `dispose()` is called at session close.
   */
  const createCodeSandbox = async (_ctx?: unknown): Promise<CodeSandbox> => {
    mkdirSync(config.scratchRoot, { recursive: true })
    const isolated = (await probe()).ok
    return scratchSandbox({
      parent: config.scratchRoot,
      os: {
        enabled: isolated,
        network: false,
        denyReadHome: true,
        // the database, its -wal/-shm files and the key files live here; this session's own
        // scratch directory and the package environments are re-allowed
        denyRead: [config.dataDir],
        allowRead: [config.envRoot, ...interpreterDirs()],
      },
      limits: {
        cpuSeconds: 120,
        fileBytes: 64 * 1024 * 1024,
        memoryBytes: 1024 * 1024 * 1024,
        // `ulimit -u` counts every process of the user: on macOS (and a busy Linux user) the
        // server's own processes already exceed it and every fork fails, so Linux only
        ...(process.platform === 'linux' ? { processes: 128 } : {}),
      },
    })
  }

  const getInstaller = async (): Promise<ReturnType<typeof localSandbox>> => {
    mkdirSync(config.envRoot, { recursive: true })
    const usable = (await probe()).ok
    installer ??= localSandbox({ root: config.envRoot, os: { enabled: usable, network: true } })
    return installer
  }

  return {
    config,
    remotePlugin: (input) => remoteCodePlugin({ ...input, programs: deps.programs }),
    filesOption: on ? { install: config.install !== 'off' } : undefined,
    plugin(input) {
      return code({
        sandbox: (ctx) => createCodeSandbox(ctx),
        mounts: [...CODE_MOUNTS],
        python: {
          command: config.python,
          ...(requirements.length > 0 ? { requirements } : {}),
          ...(building ? { envRoot: config.envRoot } : {}),
        },
        ...(building ? { installer: () => getInstaller() } : {}),
        ...(config.install === 'off'
          ? {}
          : {
              packages: {
                install: config.install,
                ...(config.install === 'allowlist' ? { allow: config.allow } : {}),
                listPath: CODE_LIST_PATH,
              },
            }),
        access: codeAccess(deps.programs, input.tools),
      })
    },
    async info() {
      if (!on)
        return {
          driver: 'off',
          python: null,
          isolated: false,
          install: 'off',
          label: 'Code sandbox is off',
        }
      const found = await probe()
      const isolated = found.ok
      const python = await pythonVersion(config.python)
      return {
        driver: config.driver,
        python,
        isolated,
        install: config.install,
        label: isolated
          ? 'local scratch directory under an OS sandbox, no network'
          : `local scratch directory, NOT isolated (${notIsolatedWhy(found)})`,
      }
    },
    async start() {
      if (config.driver !== 'local') return
      try {
        const n = await removeStaleScratch({ parent: config.scratchRoot })
        if (n > 0) warn(`removed ${n} stale code scratch director${n === 1 ? 'y' : 'ies'}`)
      } catch (error) {
        warn(`could not clean the code scratch directory: ${String(error)}`)
      }
      const found = await probe()
      if (!found.ok) warn(`code sandbox: ${notIsolatedWhy(found)}; code runs without isolation`)
    },
  }
}
