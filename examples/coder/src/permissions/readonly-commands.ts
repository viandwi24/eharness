/**
 * Conservative allowlist of read-only shell commands. They need no approval in default, plan and
 * acceptEdits mode. Anything not listed here asks.
 */
import { parseCommand } from './bash-match.ts'

type ArgCheck = (args: string[]) => boolean

const any: ArgCheck = () => true
const noFlag =
  (...flags: string[]): ArgCheck =>
  (args) =>
    !args.some((a) => flags.some((f) => a === f || a.startsWith(`${f}=`)))

const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'blame'])
const GIT_BRANCH_FLAGS = new Set([
  '-a',
  '-r',
  '-v',
  '-vv',
  '--list',
  '--show-current',
  '--all',
  '--remotes',
  '--verbose',
])

/** Command name → check of its arguments. */
const SIMPLE: Record<string, ArgCheck> = {
  ls: any,
  pwd: any,
  cat: any,
  head: any,
  tail: any,
  wc: any,
  file: any,
  stat: any,
  which: any,
  echo: any,
  grep: any,
  tree: noFlag('-o'),
  du: any,
  df: any,
  rg: noFlag('--pre', '--pre-glob'),
  sort: noFlag('-o', '--output'),
  uniq: any,
  cut: any,
  tr: any,
  basename: any,
  dirname: any,
  realpath: any,
  whoami: any,
  true: any,
  false: any,
  find: (args) =>
    !args.some((a) =>
      ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprintf', '-fls'].includes(a),
    ),
  node: (args) => args.length === 1 && (args[0] === '--version' || args[0] === '-v'),
  bun: (args) => args.length === 1 && (args[0] === '--version' || args[0] === '-v'),
  git: (args) => {
    const sub = args[0]
    const rest = args.slice(1)
    if (sub === undefined) return false
    if (GIT_READ.has(sub)) return noFlag('--output', '--ext-diff', '--textconv')(rest)
    if (sub === 'branch') return rest.every((a) => GIT_BRANCH_FLAGS.has(a))
    if (sub === 'remote') return rest.length === 1 && (rest[0] === '-v' || rest[0] === '--verbose')
    return false
  },
}

/** Redirecting to the null device does not write anything. */
const NULL_DEVICE = '/dev/null'

/** True for one normalised subcommand (`ls -la`) that only reads. */
export function isReadOnlySubcommand(subcommand: string): boolean {
  const words = subcommand.split(' ').filter((w) => w !== '')
  const name = words[0]
  if (name === undefined) return false
  const check = Object.hasOwn(SIMPLE, name) ? SIMPLE[name] : undefined
  return check?.(words.slice(1)) === true
}

/**
 * True when the whole command line only reads: every subcommand is on the allowlist, the command
 * is not complex and it redirects nowhere (except to `/dev/null`).
 *
 * @param command - Raw command line.
 */
export function isReadOnlyCommand(command: string): boolean {
  const parsed = parseCommand(command)
  if (parsed.complex || parsed.subcommands.length === 0) return false
  if (parsed.redirects.some((target) => target !== NULL_DEVICE)) return false
  return parsed.subcommands.every(isReadOnlySubcommand)
}

/** Path-like arguments of one read-only subcommand (see {@link readPathArguments}). */
export interface ReadPaths {
  /** Arguments that must resolve inside a working directory (and are matched against rules). */
  check: string[]
  /** Arguments matched against `Read` rules only (git pathspecs: they stay inside the repo). */
  match: string[]
  /** True when an argument cannot be resolved lexically (`$VAR`, `~user`, brace expansion). */
  unsafe: boolean
}

/** Commands whose arguments are plain text or names, never files they read. */
const NO_PATH_ARGS = new Set([
  'pwd',
  'echo',
  'true',
  'false',
  'whoami',
  'tr',
  'which',
  'node',
  'bun',
  'basename',
  'dirname',
])

/** A `$name`, `${…}` or `$(…` expansion (a bare trailing `$` is a regex anchor). */
const EXPANSION = /\$[A-Za-z_{(0-9@*#?!$-]/

/**
 * Path-like arguments of one normalised read-only subcommand, for the path guard: every non-flag
 * token (flag values such as `rg -f FILE` are such tokens too), the value of `--flag=value` and
 * attached values such as `-I/etc`. `find` contributes its start paths (default `.`) and
 * `-files0-from`; `git` is inside the repo (only `--no-index` and flag values are checked) and
 * its pathspecs and `rev:path` are matched against `Read` rules. Pure text analysis.
 *
 * @param subcommand - One subcommand as returned by `parseCommand`.
 */
export function readPathArguments(subcommand: string): ReadPaths {
  const words = subcommand.split(' ').filter((w) => w !== '')
  const name = words[0] ?? ''
  const args = words.slice(1)
  const out: ReadPaths = { check: [], match: [], unsafe: false }
  if (NO_PATH_ARGS.has(name)) return out

  const add = (arg: string): void => {
    if (
      EXPANSION.test(arg) ||
      arg.includes('{') ||
      arg.includes('`') ||
      (arg.startsWith('~') && arg !== '~' && !arg.startsWith('~/'))
    ) {
      out.unsafe = true
      return
    }
    out.check.push(arg)
    out.match.push(arg)
  }
  const flagValue = (flag: string): string | undefined => {
    const eq = flag.indexOf('=')
    if (flag.startsWith('--')) return eq === -1 ? undefined : flag.slice(eq + 1)
    if (eq !== -1) return flag.slice(eq + 1)
    if (name === 'cut') return undefined
    const at = flag.search(/[/~]/)
    return at > 1 ? flag.slice(at) : undefined
  }

  if (name === 'find') {
    let i = 0
    while (args[i] !== undefined && /^-[HLP]$|^-D/.test(args[i] as string)) i++
    let starts = 0
    while (args[i] !== undefined && !/^[-!(]/.test(args[i] as string)) {
      add(args[i] as string)
      starts++
      i++
    }
    if (starts === 0) add('.')
    for (let j = i; j < args.length; j++) {
      if (args[j] === '-files0-from' && args[j + 1] !== undefined) add(args[j + 1] as string)
    }
    return out
  }

  if (name === 'git') {
    const rest = args.slice(1)
    const noIndex = rest.includes('--no-index')
    for (const arg of rest) {
      if (arg === '--') continue
      if (arg.startsWith('-')) {
        const value = flagValue(arg)
        if (value !== undefined) add(value)
        continue
      }
      if (noIndex) {
        add(arg)
        continue
      }
      const colon = arg.indexOf(':')
      const spec = colon === -1 ? arg : arg.slice(colon + 1)
      if (spec !== '' && !EXPANSION.test(spec) && !spec.includes('{')) out.match.push(spec)
    }
    return out
  }

  for (const arg of args) {
    if (arg === '--' || arg === '-') continue
    if (arg.startsWith('-')) {
      const value = flagValue(arg)
      if (value !== undefined && value !== '') add(value)
      continue
    }
    add(arg)
  }
  return out
}
