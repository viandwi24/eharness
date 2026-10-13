/**
 * OS-level sandbox for shell commands: macOS Seatbelt (`sandbox-exec`) or Linux bubblewrap
 * (`bwrap`). The policy is the same on both: everything is readable, writes are limited to the
 * project root, the `allowWrite` list and temp locations, and the network is off unless allowed.
 *
 * Seatbelt (`sandbox-exec`) is deprecated by Apple but still ships with macOS. If the platform
 * tool is missing, {@link detectOsSandbox} reports `none` and callers must NOT pretend to be
 * sandboxed. Reads are open by default; `denyRead` / `denyReadHome` hide paths (Seatbelt
 * `deny file-read*`, bubblewrap `--tmpfs` / `--ro-bind /dev/null`). Not covered: CPU/memory limits
 * (see `limits` of the local sandbox) and, on macOS, local unix-socket IPC (allowed on purpose so
 * tools like git, ssh-agent and DNS lookups through mDNSResponder keep working).
 */
import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, sep } from 'node:path'

/** Which OS mechanism is available. */
export type OsSandboxKind = 'seatbelt' | 'bubblewrap' | 'none'

/** Options of {@link wrapCommand}. */
export interface WrapOptions {
  /** Project root: writable. */
  root: string
  /** Extra writable directories. */
  allowWrite: string[]
  /** Allow network access. */
  network: boolean
  /** Absolute paths whose content must not be readable. */
  denyRead?: string[]
  /** Deny the home directory (except the root, `allowWrite` and `allowRead` inside it). */
  denyReadHome?: boolean
  /** Paths re-allowed for reading inside a denied path (the root and `allowWrite` always are). */
  allowRead?: string[]
  /** Home directory for `denyReadHome`; default `os.homedir()`. */
  home?: string
  kind: OsSandboxKind
  /** Absolute path of the sandbox tool; default: `/usr/bin/sandbox-exec` or `bwrap` on PATH. */
  toolPath?: string
  /** Shell that runs the command (`<shell> -c`). Default `/bin/bash`, else `/bin/sh`. */
  shell?: string
}

const SANDBOX_EXEC = '/usr/bin/sandbox-exec'
const BWRAP_CANDIDATES = ['/usr/bin/bwrap', '/usr/local/bin/bwrap', '/bin/bwrap']

function onPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir && existsSync(`${dir}/${name}`)) return `${dir}/${name}`
  }
  return undefined
}

/** Detect the sandbox tool of this platform. `none` when missing or unsupported. */
export function detectOsSandbox(): { kind: OsSandboxKind; path?: string } {
  if (process.platform === 'darwin') {
    return existsSync(SANDBOX_EXEC) ? { kind: 'seatbelt', path: SANDBOX_EXEC } : { kind: 'none' }
  }
  if (process.platform === 'linux') {
    const path = BWRAP_CANDIDATES.find((p) => existsSync(p)) ?? onPath('bwrap')
    return path ? { kind: 'bubblewrap', path } : { kind: 'none' }
  }
  return { kind: 'none' }
}

/** Escape a string for an SBPL string literal. */
export function sbplString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
}

function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** Unique, symlink-resolved writable directories (Seatbelt matches real paths only). */
function writableDirs(opts: Pick<WrapOptions, 'root' | 'allowWrite'>): string[] {
  const set = new Set<string>()
  for (const p of [opts.root, ...opts.allowWrite]) {
    set.add(p)
    set.add(real(p))
  }
  return [...set]
}

type ReadOpts = Pick<
  WrapOptions,
  'root' | 'allowWrite' | 'denyRead' | 'denyReadHome' | 'allowRead' | 'home'
>

function isInside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep)
}

/** The denied paths (as given) and the paths re-allowed inside them (root, `allowWrite`, `allowRead`). */
export function readPolicy(opts: ReadOpts): { deny: string[]; reallow: string[] } {
  const deny = [
    ...new Set([...(opts.denyRead ?? []), ...(opts.denyReadHome ? [opts.home ?? homedir()] : [])]),
  ]
  if (deny.length === 0) return { deny, reallow: [] }
  const reallow = [...new Set([opts.root, ...opts.allowWrite, ...(opts.allowRead ?? [])])].filter(
    (p) => deny.some((d) => isInside(p, d) || isInside(real(p), real(d))),
  )
  return { deny, reallow }
}

/** Both spellings of each path (as given and symlink-resolved), unique. */
function bothForms(paths: string[]): string[] {
  return [...new Set(paths.flatMap((p) => [p, real(p)]))]
}

/**
 * Generate the Seatbelt profile (SBPL). Default-allow with file writes and network denied, then
 * writes re-allowed for the root, `allowWrite`, temp dirs and a few device files.
 */
export function seatbeltProfile(opts: ReadOpts & Pick<WrapOptions, 'network'>): string {
  const subpaths = [
    ...writableDirs(opts),
    '/tmp',
    '/private/tmp',
    '/private/var/folders',
    real(tmpdir()),
  ]
  const unique = [...new Set(subpaths)]
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    '(allow file-write*',
    ...unique.map((p) => `  (subpath ${sbplString(p)})`),
    '  (literal "/dev/null")',
    '  (literal "/dev/zero")',
    '  (literal "/dev/dtracehelper")',
    '  (regex #"^/dev/tty")',
    '  (regex #"^/dev/ttys[0-9]+$"))',
  ]
  const { deny, reallow } = readPolicy(opts)
  if (deny.length > 0) {
    for (const p of bothForms(deny)) lines.push(`(deny file-read* (subpath ${sbplString(p)}))`)
    for (const p of bothForms(reallow)) lines.push(`(allow file-read* (subpath ${sbplString(p)}))`)
    // Walking down to a re-allowed path needs metadata of every directory above it.
    const parents = new Set<string>()
    for (const p of bothForms(reallow)) {
      for (let d = dirname(p); d !== dirname(d); d = dirname(d)) parents.add(d)
    }
    for (const d of parents) {
      lines.push(`(allow file-read-metadata (literal ${sbplString(d)}))`)
    }
  }
  if (!opts.network) {
    lines.push('(deny network*)')
    // Local unix sockets stay usable (git credential helpers, ssh-agent, mDNSResponder).
    lines.push('(allow network* (remote unix-socket))')
    lines.push('(allow network* (local unix-socket))')
  }
  return `${lines.join('\n')}\n`
}

/** Default shell of this machine: `/bin/bash`, else `/bin/sh`. */
export function defaultShell(): string {
  return existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh'
}

function shellArgv(command: string, shell?: string): string[] {
  return [shell ?? defaultShell(), '-c', command]
}

/**
 * Build the argv that runs `command` (through bash -c) inside the sandbox. For kind `none` the
 * plain shell argv is returned: check `kind` before claiming isolation.
 */
export function wrapCommand(command: string, opts: WrapOptions): string[] {
  const shell = shellArgv(command, opts.shell)
  if (opts.kind === 'seatbelt') {
    return [opts.toolPath ?? SANDBOX_EXEC, '-p', seatbeltProfile(opts), ...shell]
  }
  if (opts.kind === 'bubblewrap') {
    const dirs = [...new Set([opts.root, ...opts.allowWrite])]
    const argv = [
      opts.toolPath ?? 'bwrap',
      '--ro-bind',
      '/',
      '/',
      '--dev',
      '/dev',
      '--proc',
      '/proc',
      '--tmpfs',
      '/tmp', // before the binds: the root may live under /tmp
    ]
    // Order matters (later mounts win): writable binds first, then the denies (so a deny inside
    // the root or an allowWrite directory is not lost), then the re-allows.
    for (const d of dirs) argv.push('--bind', d, d)
    const { deny, reallow } = readPolicy(opts)
    for (const p of deny) {
      let isDir: boolean
      try {
        isDir = statSync(p).isDirectory()
      } catch {
        continue // nothing to hide, and bwrap fails on a missing mount source
      }
      if (isDir) argv.push('--tmpfs', p)
      else argv.push('--ro-bind', '/dev/null', p)
    }
    // Re-allowed paths come back after the denies; the root and allowWrite stay writable.
    for (const d of reallow) {
      if (!existsSync(d)) continue // bwrap fails on a missing mount source
      argv.push(dirs.includes(d) ? '--bind' : '--ro-bind', d, d)
    }
    // Own PID and IPC namespaces and a new session (no TIOCSTI / signals to the host's processes).
    argv.push('--unshare-pid', '--unshare-ipc', '--new-session')
    if (!opts.network) argv.push('--unshare-net')
    argv.push('--die-with-parent', '--chdir', opts.root, '--', ...shell)
    return argv
  }
  return shell
}

/** Message fragments that signal a sandbox-denied operation. */
export const SANDBOX_DENIAL: RegExp = /Operation not permitted|Read-only file system/i

/** Hint appended to bash results when a denial message shows up while the sandbox is on. */
export const SANDBOX_HINT =
  '(The command ran in the OS sandbox: writes outside the project and network access are blocked.)'
