/**
 * Python environments of the code plugin (spec 28 §5): the base interpreter or a virtual
 * environment built from the developer's requirement lines, the workspace environment with the
 * accepted extra packages, the probe and the requirement parser.
 *
 * Built only with the public core API (ADR-0008); Web APIs only.
 *
 * @see docs/specs/28-code-plugin.md
 */
import { errorText } from '../index.ts'
import { PROBE_SCRIPT, PURELIB_SCRIPT, VERSION_SCRIPT } from './scripts.ts'
import { type Sandbox, sha1Hex, shellQuote } from './sync.ts'

/** A parsed requirement line (`pandas-ta>=0.3`). */
export interface ParsedRequirement {
  /** Normalized project name (lower case, runs of `-_.` become `-`). */
  name: string
  /** Version specifier without spaces (`>=1.0,<2`), or `''`. */
  specifier: string
  /** Canonical line: `name` + `specifier`. */
  line: string
}

const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/
const CLAUSE = /^(?:===|==|~=|!=|>=|<=|>|<)[A-Za-z0-9][A-Za-z0-9.*+!_-]*$/

/**
 * Parse one requirement line: a package name with an optional version specifier. URLs, paths,
 * options, extras, markers and `-r` are rejected.
 *
 * @example
 * ```ts
 * parseRequirement('Pandas_TA >= 0.3') // { ok: true, requirement: { name: 'pandas-ta', specifier: '>=0.3', line: 'pandas-ta>=0.3' } }
 * ```
 * @see docs/specs/28-code-plugin.md#3-tools-model-visible-text-changes-are-a-minor-change
 */
export function parseRequirement(
  line: string,
): { ok: true; requirement: ParsedRequirement } | { ok: false } {
  if (typeof line !== 'string') return { ok: false }
  const text = line.trim()
  if (text === '' || text.length > 200) return { ok: false }
  const at = text.search(/[=<>~!\s]/)
  const rawName = at < 0 ? text : text.slice(0, at)
  const rest = at < 0 ? '' : text.slice(at).replace(/\s+/g, '')
  if (!NAME.test(rawName)) return { ok: false }
  if (rest !== '' && !rest.split(',').every((clause) => CLAUSE.test(clause))) return { ok: false }
  const name = rawName.toLowerCase().replace(/[-_.]+/g, '-')
  return { ok: true, requirement: { name, specifier: rest, line: `${name}${rest}` } }
}

/** Why an environment could not be built. */
export class EnvironmentError extends Error {}

/** Result of the probe (spec 28 §5.3). */
export interface ProbeResult {
  version: string
  packages: Array<[string, string]>
}

/** What {@link Environments.ensure} returns. */
export interface EnsuredEnvironment {
  /** Interpreter command to run scripts with. */
  python: string
  /** Cache key of the environment. */
  key: string
  /** Set when something was (re)built by this call. */
  rebuilt?: { packages: number; seconds: number }
}

/** Options of {@link createEnvironments}. */
export interface EnvironmentsOptions {
  /** Interpreter inside the sandbox when no environment is built. */
  command: string
  /** Requirement lines of the base environment. */
  requirements: readonly string[]
  /** Absolute directory of the environments (inside the sandbox, outside the work directory). */
  envRoot?: string
  /** Sandbox that builds environments (network on, writes only under `envRoot`). */
  installer?: Sandbox
  /** Index URL passed to pip / uv. */
  indexUrl?: string
  /** The sandbox model code runs in (the probe runs here). */
  runtime: Sandbox
  /** Validate one extra requirement line (parse + allowlist); a returned string is the error. */
  validate?: (line: string) => string | undefined
}

/** The environments of one session. */
export interface Environments {
  /** Make sure the interpreter for `extras` exists, building it when needed. Throws {@link EnvironmentError}. */
  ensure(extras: readonly string[]): Promise<EnsuredEnvironment>
  /** The base interpreter when it is ready without building (no requirements, or already built), else `undefined`. */
  peek(): Promise<EnsuredEnvironment | undefined>
  /** Probe an interpreter (cached per key; `undefined` when the probe fails). */
  probe(env: { python: string; key: string }): Promise<ProbeResult | undefined>
}

const OK_FILE = '.eh-ok'

function tail(text: string, max = 2000): string {
  const trimmed = text.trim()
  return trimmed.length > max ? trimmed.slice(trimmed.length - max) : trimmed
}

/** `name major.minor` list for the description and the hints (at most `max`, sorted by name). */
export function formatPackages(packages: ReadonlyArray<[string, string]>, max = 60): string {
  const sorted = [...packages].sort((a, b) => a[0].toLowerCase().localeCompare(b[0].toLowerCase()))
  const shown = sorted
    .slice(0, max)
    .map(([name, version]) => `${name} ${version.split('.').slice(0, 2).join('.')}`)
  const more = sorted.length - shown.length
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ')
}

/**
 * Create the environment manager of a session. `probeCache` is shared by the plugin instance
 * (process lifetime).
 */
export function createEnvironments(
  options: EnvironmentsOptions,
  probeCache: Map<string, ProbeResult> = new Map(),
): Environments {
  const { command, installer, runtime, envRoot } = options
  const baseLines = [...options.requirements].sort()
  let baseKey: string | undefined
  let uv: boolean | undefined

  async function sh(
    sandbox: Sandbox,
    cmd: string,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    try {
      // Installer commands run with envRoot as the working directory, so files of the work
      // directory (or whatever the installer's cwd is) cannot be picked up by pip or Python.
      const cwd =
        sandbox === installer && envRoot !== undefined
          ? `mkdir -p -- ${shellQuote(envRoot)} && cd ${shellQuote(envRoot)} && `
          : ''
      return await sandbox.run({
        command: `${cwd}${cmd}`,
        abortSignal: AbortSignal.timeout(15 * 60_000),
      })
    } catch (error) {
      throw new EnvironmentError(errorText(error))
    }
  }

  async function must(sandbox: Sandbox, cmd: string): Promise<string> {
    const r = await sh(sandbox, cmd)
    if (r.exitCode !== 0) throw new EnvironmentError(tail(`${r.stdout}\n${r.stderr}`))
    return r.stdout
  }

  const requireBuilder = (): { installer: Sandbox; envRoot: string } => {
    if (installer === undefined || envRoot === undefined) {
      throw new EnvironmentError('no installer or envRoot is configured')
    }
    return { installer, envRoot }
  }

  async function hasUv(sandbox: Sandbox): Promise<boolean> {
    uv ??= (await sh(sandbox, 'command -v uv')).exitCode === 0
    return uv
  }

  async function keyOfBase(): Promise<string> {
    if (baseKey !== undefined) return baseKey
    const { installer: ins } = requireBuilder()
    const version = (
      await must(ins, `${shellQuote(command)} -I -c ${shellQuote(VERSION_SCRIPT)}`)
    ).trim()
    baseKey = (await sha1Hex(`${version}\n${baseLines.join('\n')}`)).slice(0, 16)
    return baseKey
  }

  async function install(ins: Sandbox, python: string, lines: readonly string[]): Promise<void> {
    const index =
      options.indexUrl === undefined ? '' : ` --index-url ${shellQuote(options.indexUrl)}`
    const args = lines.map(shellQuote).join(' ')
    if (await hasUv(ins)) {
      await must(
        ins,
        `uv pip install --python ${shellQuote(python)} --only-binary :all:${index} ${args}`,
      )
    } else {
      await must(ins, `${shellQuote(python)} -I -m pip install --only-binary=:all:${index} ${args}`)
    }
  }

  async function makeVenv(
    ins: Sandbox,
    python: string,
    dir: string,
    systemSitePackages: boolean,
  ): Promise<void> {
    await must(ins, `rm -rf ${shellQuote(dir)}`)
    if (await hasUv(ins)) {
      await must(
        ins,
        `uv venv ${systemSitePackages ? '--system-site-packages ' : ''}--python ${shellQuote(python)} ${shellQuote(dir)}`,
      )
    } else {
      await must(
        ins,
        `${shellQuote(python)} -I -m venv ${systemSitePackages ? '--system-site-packages ' : ''}${shellQuote(dir)}`,
      )
    }
  }

  async function isReady(ins: Sandbox, dir: string): Promise<boolean> {
    try {
      return (await ins.readTextFile({ path: `${dir}/${OK_FILE}` })) !== null
    } catch {
      return false
    }
  }

  async function ensureBase(): Promise<EnsuredEnvironment> {
    if (baseLines.length === 0) return { python: command, key: `plain:${command}` }
    const { installer: ins, envRoot: root } = requireBuilder()
    const key = await keyOfBase()
    const dir = `${root}/base-${key}`
    const python = `${dir}/bin/python`
    if (await isReady(ins, dir)) return { python, key: `base-${key}` }
    const started = Date.now()
    await makeVenv(ins, command, dir, false)
    await install(ins, python, baseLines)
    await ins.writeTextFile({ path: `${dir}/${OK_FILE}`, content: `${new Date().toISOString()}\n` })
    return {
      python,
      key: `base-${key}`,
      rebuilt: { packages: baseLines.length, seconds: (Date.now() - started) / 1000 },
    }
  }

  async function ensure(extras: readonly string[]): Promise<EnsuredEnvironment> {
    const base = await ensureBase()
    const lines = [...new Set(extras)].sort()
    if (lines.length === 0) return base
    const { installer: ins, envRoot: root } = requireBuilder()
    const key = (await sha1Hex(`${base.key}\n${lines.join('\n')}`)).slice(0, 16)
    const dir = `${root}/ws-${key}`
    const python = `${dir}/bin/python`
    if (await isReady(ins, dir))
      return { python, key: `ws-${key}`, ...(base.rebuilt ? { rebuilt: base.rebuilt } : {}) }
    const started = Date.now()
    for (const line of lines) {
      const problem = options.validate?.(line)
      if (problem !== undefined) throw new EnvironmentError(problem)
    }
    await makeVenv(ins, base.python, dir, true)
    if (baseLines.length > 0) {
      const own = (
        await must(ins, `${shellQuote(python)} -I -c ${shellQuote(PURELIB_SCRIPT)}`)
      ).trim()
      const parent = (
        await must(ins, `${shellQuote(base.python)} -I -c ${shellQuote(PURELIB_SCRIPT)}`)
      ).trim()
      await ins.writeTextFile({ path: `${own}/eh-base.pth`, content: `${parent}\n` })
    }
    await install(ins, python, lines)
    await ins.writeTextFile({ path: `${dir}/${OK_FILE}`, content: `${new Date().toISOString()}\n` })
    const rebuilt = {
      packages: lines.length + (base.rebuilt?.packages ?? 0),
      seconds: (Date.now() - started) / 1000 + (base.rebuilt?.seconds ?? 0),
    }
    return { python, key: `ws-${key}`, rebuilt }
  }

  async function peek(): Promise<EnsuredEnvironment | undefined> {
    if (baseLines.length === 0) return { python: command, key: `plain:${command}` }
    try {
      const { installer: ins, envRoot: root } = requireBuilder()
      const key = await keyOfBase()
      const dir = `${root}/base-${key}`
      return (await isReady(ins, dir))
        ? { python: `${dir}/bin/python`, key: `base-${key}` }
        : undefined
    } catch {
      return undefined
    }
  }

  async function probe(env: { python: string; key: string }): Promise<ProbeResult | undefined> {
    const cached = probeCache.get(env.key)
    if (cached !== undefined) return cached
    try {
      const r = await runtime.run({
        command: `${shellQuote(env.python)} -I -c ${shellQuote(PROBE_SCRIPT)}`,
      })
      if (r.exitCode !== 0) return undefined
      const parsed = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as ProbeResult
      if (typeof parsed.version !== 'string' || !Array.isArray(parsed.packages)) return undefined
      probeCache.set(env.key, parsed)
      return parsed
    } catch {
      return undefined
    }
  }

  return { ensure, peek, probe }
}
