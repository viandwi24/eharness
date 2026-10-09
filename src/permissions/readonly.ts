/**
 * Allowlist of read-only shell commands (spec 18 §6). They need no approval in default, plan and
 * acceptEdits mode; anything not accepted here asks (or is denied in plan mode).
 *
 * Threat model: the model (or a prompt injection steering it) picks the command line. An
 * auto-approved command must not be able to write a file, run another program or read a file the
 * path guard cannot see. A flag deny-list always loses to a flag the author did not think of
 * (`sort -oREADME.md`, `sort --ou=x`, `find -fprint0`, `uniq in out`), so every command here has
 * an **argument grammar that is an allow-list**: the accepted flags (exactly as written: GNU
 * long-option abbreviations such as `--ou` are NOT accepted), which of them take a value, and
 * how many positional arguments the command takes and what each one is. Anything else (unknown
 * flag, missing value, too many positionals) is not read-only.
 *
 * | command        | accepted                                         | refused (examples)                      |
 * |----------------|--------------------------------------------------|-----------------------------------------|
 * | ls du df stat  | display flags, any number of paths               | unknown flags                           |
 * | cat head tail  | display flags, `-n N`, files (no `tail -f`)      | `tail -f`, `--follow`                   |
 * | wc file cut    | counting/format flags, files                     | `file -C -m -f`                         |
 * | sort           | ordering flags, `-k -t -S`, files                | `-o*`, `--o*`, `--output`, `-T`,        |
 * |                |                                                  | `--compress-program`, `--files0-from`   |
 * | uniq           | display flags, at most ONE file (the 2nd = out)  | `uniq in out`                           |
 * | grep           | match flags, `-e`, `-A/-B/-C/-m`, `--include`    | `-f FILE`, `--exclude-from`             |
 * | rg             | match flags, `-g`, `-t`, `-A/-B/-C/-m`           | `--pre`, `--pre-glob`, `--hostname-bin`,|
 * |                |                                                  | `-z`, `-f`, `--ignore-file`             |
 * | find           | tests and `-print*`/`-ls`/`-printf` actions      | `-exec* -ok* -delete -f*` (`-fprint0`,  |
 * |                |                                                  | `-fls`, `-fprintf`), `-files0-from`     |
 * | git            | status log diff show rev-parse ls-files blame    | `--output`, `--ext-diff`, `--textconv`, |
 * |                | branch -a/-r/-v/--list, remote -v                | `--contents`, `-c`, `-C`, mutations     |
 * | echo tr which  | text arguments only                              | any `$` expansion or backtick           |
 * | basename etc.  | text arguments only                              |                                         |
 * | node bun       | `--version` / `-v` only                          | everything else                         |
 *
 * `tree` is not on the list (`-o FILE` writes; not worth a grammar). Residual limits: a
 * repository's own git config (`diff.external`, textconv drivers, pager) can still run programs
 * for `git diff|log|show`; quoted arguments with spaces are split by the normaliser (this only
 * ever makes the analysis stricter).
 */
import { parseCommand } from './command.ts'

/** What a positional argument is. */
type Kind =
  /** Files whose content is read (rule coverage applies to directories and globs). */
  | 'content'
  /** Paths that are only listed or stat-ed (contained and rule-matched, never "covered"). */
  | 'meta'
  /** Plain text (names, patterns, translations): never a path. */
  | 'text'
  /** git revisions and pathspecs (rule-matched only; contained when `--no-index`). */
  | 'git'

/** Argument grammar of one command (an allow-list). */
interface Spec {
  /** Boolean short flags, may be clustered (`-la`). */
  short?: string
  /** Short flags that take a value (`-n5` or `-n 5`). */
  shortValue?: string
  /** `-NUM` is accepted (`head -5`). */
  numeric?: boolean
  /** Boolean long flags, exactly as written. */
  long?: readonly string[]
  /** Long flags that take a value (`--x=v` or `--x v`). */
  longValue?: readonly string[]
  /** Long flags that are bare or take `=v` (`--color`, `--color=auto`). */
  longOpt?: readonly string[]
  /** Tokens accepted verbatim (`-uno`). */
  exact?: readonly string[]
  /** Flags (`e`, `--regexp`) whose value is the pattern: no positional pattern then. */
  patternFlags?: readonly string[]
  /** Flags that make the command recurse into directories. */
  recursiveFlags?: readonly string[]
  /** Flags after which there is no pattern (`rg --files`) and positionals are listed paths. */
  noPatternFlags?: readonly string[]
  /** The first positional is a pattern (unless a pattern flag was given). */
  pattern?: boolean
  /** Always recurses (`rg`). */
  recursive?: boolean
  /** Maximum number of positionals (after the pattern). */
  max: number
  /** Role of the positionals. */
  kind: Kind
  /** With no path (and recursion for `grep`) the command works on `.`. */
  dot?: 'always' | 'recursive'
}

const DISPLAY_LONG = ['help', 'version'] as const

const SPECS: Record<string, Spec> = {
  ls: {
    short: '1aAcdFghiklLmnopqrRsStuUxX',
    long: [
      'all',
      'almost-all',
      'directory',
      'classify',
      'human-readable',
      'inode',
      'dereference',
      'reverse',
      'recursive',
      'size',
      ...DISPLAY_LONG,
    ],
    longOpt: ['color'],
    max: 1000,
    kind: 'meta',
    dot: 'always',
  },
  pwd: { short: 'LP', max: 0, kind: 'text' },
  cat: {
    short: 'AbeEnstTuv',
    long: [
      'show-all',
      'number-nonblank',
      'show-ends',
      'number',
      'squeeze-blank',
      'show-tabs',
      'show-nonprinting',
    ],
    max: 1000,
    kind: 'content',
  },
  head: {
    short: 'qvz',
    shortValue: 'nc',
    numeric: true,
    long: ['quiet', 'silent', 'verbose', 'zero-terminated'],
    longValue: ['lines', 'bytes'],
    max: 1000,
    kind: 'content',
  },
  tail: {
    short: 'qvz',
    shortValue: 'nc',
    numeric: true,
    long: ['quiet', 'silent', 'verbose', 'zero-terminated'],
    longValue: ['lines', 'bytes'],
    max: 1000,
    kind: 'content',
  },
  wc: {
    short: 'clmwL',
    long: ['bytes', 'chars', 'lines', 'words', 'max-line-length'],
    max: 1000,
    kind: 'content',
  },
  file: {
    short: 'bhiLz',
    long: ['brief', 'mime', 'mime-type', 'mime-encoding', 'dereference'],
    max: 1000,
    kind: 'content',
  },
  stat: {
    short: 'Lft',
    shortValue: 'c',
    long: ['dereference', 'file-system', 'terse'],
    longValue: ['format'],
    max: 1000,
    kind: 'meta',
  },
  which: { short: 'a', max: 1000, kind: 'text' },
  grep: {
    short: 'EFGPiIvwxcLlnoqsHhbTZzaUrRV',
    shortValue: 'ABCme',
    numeric: true,
    long: [
      'extended-regexp',
      'fixed-strings',
      'basic-regexp',
      'perl-regexp',
      'ignore-case',
      'no-ignore-case',
      'invert-match',
      'word-regexp',
      'line-regexp',
      'count',
      'files-without-match',
      'files-with-matches',
      'only-matching',
      'quiet',
      'silent',
      'no-messages',
      'with-filename',
      'no-filename',
      'line-number',
      'byte-offset',
      'null',
      'null-data',
      'text',
      'recursive',
      'dereference-recursive',
      'initial-tab',
      'version',
    ],
    longValue: [
      'after-context',
      'before-context',
      'context',
      'max-count',
      'regexp',
      'include',
      'exclude',
      'exclude-dir',
    ],
    longOpt: ['color', 'colour', 'binary-files'],
    patternFlags: ['e', '--regexp'],
    recursiveFlags: ['r', 'R', '--recursive', '--dereference-recursive'],
    pattern: true,
    max: 1000,
    kind: 'content',
    dot: 'recursive',
  },
  rg: {
    short: 'iSsvwxcloHhnNuUaLFIpqV',
    shortValue: 'ABCegmtTjMdr',
    long: [
      'ignore-case',
      'smart-case',
      'case-sensitive',
      'invert-match',
      'word-regexp',
      'line-regexp',
      'count',
      'count-matches',
      'files-with-matches',
      'files-without-match',
      'only-matching',
      'hidden',
      'no-ignore',
      'no-ignore-vcs',
      'no-ignore-parent',
      'no-ignore-dot',
      'no-ignore-global',
      'follow',
      'fixed-strings',
      'line-number',
      'no-line-number',
      'with-filename',
      'no-filename',
      'heading',
      'no-heading',
      'column',
      'json',
      'files',
      'type-list',
      'multiline',
      'multiline-dotall',
      'null',
      'stats',
      'quiet',
      'no-messages',
      'unrestricted',
      'vimgrep',
      'trim',
      'text',
      'pretty',
      'sort-files',
      'no-config',
      'pcre2',
      'no-pcre2',
      'binary',
      'no-binary',
      'crlf',
      'version',
    ],
    longValue: [
      'regexp',
      'glob',
      'iglob',
      'max-count',
      'max-depth',
      'type',
      'type-not',
      'threads',
      'after-context',
      'before-context',
      'context',
      'replace',
      'max-columns',
      'sort',
      'sortr',
      'max-filesize',
    ],
    longOpt: ['color'],
    patternFlags: ['e', '--regexp'],
    noPatternFlags: ['--files', '--type-list'],
    pattern: true,
    recursive: true,
    max: 1000,
    kind: 'content',
    dot: 'always',
  },
  sort: {
    short: 'bcCdfghiMnrRsuVzm',
    shortValue: 'ktS',
    long: [
      'ignore-leading-blanks',
      'dictionary-order',
      'ignore-case',
      'general-numeric-sort',
      'human-numeric-sort',
      'month-sort',
      'numeric-sort',
      'random-sort',
      'reverse',
      'stable',
      'unique',
      'version-sort',
      'zero-terminated',
      'check',
      'merge',
      'ignore-nonprinting',
    ],
    longValue: ['key', 'field-separator', 'buffer-size'],
    max: 1000,
    kind: 'content',
  },
  uniq: {
    short: 'cdDiuz',
    shortValue: 'fsw',
    long: ['count', 'repeated', 'ignore-case', 'unique', 'zero-terminated'],
    longValue: ['skip-fields', 'skip-chars', 'check-chars'],
    // the second positional of uniq is the OUTPUT file
    max: 1,
    kind: 'content',
  },
  cut: {
    short: 'snz',
    shortValue: 'bcdf',
    long: ['only-delimited', 'zero-terminated', 'complement'],
    longValue: ['bytes', 'characters', 'delimiter', 'fields'],
    longOpt: ['output-delimiter'],
    max: 1000,
    kind: 'content',
  },
  tr: { short: 'cdst', max: 2, kind: 'text' },
  basename: {
    short: 'az',
    shortValue: 's',
    long: ['multiple', 'zero'],
    longValue: ['suffix'],
    max: 1000,
    kind: 'text',
  },
  dirname: { short: 'z', long: ['zero'], max: 1000, kind: 'text' },
  realpath: {
    short: 'emsqLPz',
    long: [
      'canonicalize-existing',
      'canonicalize-missing',
      'no-symlinks',
      'quiet',
      'logical',
      'physical',
      'zero',
      'strip',
    ],
    max: 1000,
    kind: 'meta',
  },
  whoami: { max: 0, kind: 'text' },
  true: { max: 0, kind: 'text' },
  false: { max: 0, kind: 'text' },
  du: {
    short: 'abchHkLmsSxP',
    shortValue: 'd',
    long: ['all', 'bytes', 'total', 'human-readable', 'summarize', 'one-file-system'],
    longValue: ['max-depth'],
    max: 1000,
    kind: 'meta',
    dot: 'always',
  },
  df: {
    short: 'ahHiklPT',
    shortValue: 'tx',
    long: ['all', 'human-readable', 'inodes', 'local', 'portability', 'print-type'],
    max: 1000,
    kind: 'meta',
  },
}

// ─── git ─────────────────────────────────────────────────────────────────────────────────────

const GIT_DIFF_LONG = [
  'stat',
  'shortstat',
  'numstat',
  'name-only',
  'name-status',
  'summary',
  'patch',
  'no-patch',
  'raw',
  'no-color',
  'no-ext-diff',
  'cached',
  'staged',
  'check',
  'minimal',
  'patience',
  'histogram',
  'ignore-all-space',
  'ignore-space-change',
  'ignore-space-at-eol',
  'ignore-blank-lines',
  'no-renames',
  'oneline',
  'graph',
  'decorate',
  'no-decorate',
  'all',
  'abbrev-commit',
  'no-abbrev-commit',
  'no-merges',
  'merges',
  'reverse',
  'follow',
  'first-parent',
  'topo-order',
  'date-order',
  'author-date-order',
  'full-diff',
  'left-right',
  'cherry-pick',
  'source',
  'no-index',
  'full-index',
  'binary',
  'text',
  'root',
  'cc',
  'diff-merges',
] as const

const GIT_DIFF: Spec = {
  short: 'pPuwbaczsMCB',
  shortValue: 'nUSGL',
  numeric: true,
  long: GIT_DIFF_LONG,
  longValue: [
    'max-count',
    'skip',
    'since',
    'until',
    'after',
    'before',
    'author',
    'committer',
    'grep',
    'format',
    'date',
    'diff-filter',
    'diff-algorithm',
    'stat-width',
    'stat-name-width',
  ],
  longOpt: [
    'color',
    'abbrev',
    'stat',
    'word-diff',
    'dirstat',
    'find-renames',
    'find-copies',
    'unified',
    'relative',
    'pretty',
  ],
  max: 1000,
  kind: 'git',
}

const GIT_SPECS: Record<string, Spec> = {
  status: {
    short: 'sbvzq',
    long: ['short', 'branch', 'long', 'verbose', 'show-stash', 'no-renames', 'renames', 'null'],
    longOpt: ['porcelain', 'ignored', 'untracked-files', 'ignore-submodules', 'column'],
    exact: ['-uno', '-unormal', '-uall', '-u'],
    max: 1000,
    kind: 'git',
  },
  log: GIT_DIFF,
  diff: GIT_DIFF,
  show: GIT_DIFF,
  'rev-parse': {
    long: [
      'show-toplevel',
      'git-dir',
      'absolute-git-dir',
      'git-common-dir',
      'show-prefix',
      'show-cdup',
      'is-inside-work-tree',
      'is-inside-git-dir',
      'is-bare-repository',
      'symbolic',
      'symbolic-full-name',
      'verify',
      'quiet',
      'all',
      'branches',
      'tags',
      'remotes',
    ],
    longOpt: ['short', 'abbrev-ref'],
    max: 1000,
    kind: 'git',
  },
  'ls-files': {
    short: 'cdmoskuzvt',
    shortValue: 'x',
    long: [
      'cached',
      'deleted',
      'modified',
      'others',
      'ignored',
      'stage',
      'unmerged',
      'killed',
      'directory',
      'empty-directory',
      'no-empty-directory',
      'resolve-undo',
      'exclude-standard',
      'full-name',
      'error-unmatch',
      'deduplicate',
    ],
    longValue: ['exclude'],
    max: 1000,
    kind: 'git',
  },
  blame: {
    short: 'wsepltfnbMC',
    shortValue: 'L',
    long: [
      'porcelain',
      'line-porcelain',
      'incremental',
      'show-name',
      'show-number',
      'show-email',
      'root',
      'first-parent',
      'ignore-whitespace',
    ],
    max: 1000,
    kind: 'git',
  },
}

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

// ─── find ────────────────────────────────────────────────────────────────────────────────────

/** `find` primaries without an argument. No `-exec*`, `-ok*`, `-delete`, `-f*` file actions. */
const FIND_BARE = new Set([
  '-true',
  '-false',
  '-and',
  '-or',
  '-not',
  '-a',
  '-o',
  '!',
  '(',
  ')',
  ',',
  '-empty',
  '-readable',
  '-writable',
  '-executable',
  '-print',
  '-print0',
  '-prune',
  '-ls',
  '-nouser',
  '-nogroup',
  '-depth',
  '-xdev',
  '-mount',
  '-noleaf',
  '-follow',
  '-daystart',
  '-ignore_readdir_race',
  '-nowarn',
  '-warn',
  '-quit',
])
/** `find` primaries with one argument that is a pattern, number or word (never a file we open). */
const FIND_VALUE = new Set([
  '-name',
  '-iname',
  '-path',
  '-ipath',
  '-wholename',
  '-iwholename',
  '-regex',
  '-iregex',
  '-regextype',
  '-lname',
  '-ilname',
  '-type',
  '-xtype',
  '-size',
  '-mtime',
  '-atime',
  '-ctime',
  '-mmin',
  '-amin',
  '-cmin',
  '-perm',
  '-user',
  '-group',
  '-uid',
  '-gid',
  '-links',
  '-inum',
  '-maxdepth',
  '-mindepth',
  '-fstype',
  '-printf',
])
/** `find` primaries with one file argument (only its metadata is read). */
const FIND_FILE = new Set(['-newer', '-samefile'])

// ─── argument parsing ────────────────────────────────────────────────────────────────────────

interface Parsed {
  positionals: string[]
  /** Flags seen, as written without value (`r`, `--recursive`). */
  flags: Set<string>
}

function parseArgs(spec: Spec, args: readonly string[]): Parsed | undefined {
  const flags = new Set<string>()
  const positionals: string[] = []
  const long = new Set(spec.long ?? [])
  const longValue = new Set(spec.longValue ?? [])
  const longOpt = new Set(spec.longOpt ?? [])
  const exact = new Set(spec.exact ?? [])
  const short = spec.short ?? ''
  const shortValue = spec.shortValue ?? ''
  let afterDashes = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (afterDashes || arg === '-' || !arg.startsWith('-')) {
      positionals.push(arg)
      continue
    }
    if (arg === '--') {
      afterDashes = true
      continue
    }
    if (exact.has(arg)) {
      flags.add(arg)
      continue
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
      if (long.has(name) && eq === -1) {
        flags.add(`--${name}`)
      } else if (longOpt.has(name)) {
        flags.add(`--${name}`)
      } else if (longValue.has(name)) {
        flags.add(`--${name}`)
        if (eq === -1) {
          if (args[i + 1] === undefined) return undefined
          i++
        } else if (arg.slice(eq + 1) === '') {
          return undefined
        }
      } else {
        return undefined
      }
      continue
    }
    if (spec.numeric === true && /^-\d+$/.test(arg)) continue
    for (let j = 1; j < arg.length; j++) {
      const ch = arg[j] as string
      if (short.includes(ch)) {
        flags.add(ch)
        continue
      }
      if (shortValue.includes(ch)) {
        flags.add(ch)
        if (j + 1 >= arg.length) {
          if (args[i + 1] === undefined) return undefined
          i++
        }
        break
      }
      return undefined
    }
  }
  return { positionals, flags }
}

/** A path-like argument that may be matched by the shell (`*`, `?`, `[`). */
export function isGlobArg(arg: string): boolean {
  return /[*?[]/.test(arg)
}

/** A path argument as the guard sees it, and whether its whole subtree is read. */
export interface Cover {
  arg: string
  /** A directory argument of a recursive command: everything below it is read. */
  subtree: boolean
}

/** Result of analysing a read-only subcommand. */
interface Analysis {
  /** Arguments that must resolve inside a working directory and are matched against rules. */
  check: string[]
  /** Arguments matched against `Read` rules only (git pathspecs). */
  match: string[]
  /** Arguments whose content is read: directories (recursion) and globs cover a subtree. */
  cover: Cover[]
  /** Text arguments (for the expansion check). */
  words: string[]
}

function analyzeSpec(spec: Spec, args: readonly string[]): Analysis | undefined {
  const parsed = parseArgs(spec, args)
  if (parsed === undefined) return undefined
  const pos = [...parsed.positionals]
  const has = (names: readonly string[] | undefined): boolean =>
    (names ?? []).some((n) => parsed.flags.has(n))
  const noPattern = has(spec.noPatternFlags)
  if (spec.pattern === true && !has(spec.patternFlags) && !noPattern) pos.shift()
  if (pos.length > spec.max) return undefined
  const recursive = spec.recursive === true || has(spec.recursiveFlags)
  const out: Analysis = { check: [], match: [], cover: [], words: [] }
  if (spec.kind === 'text') {
    out.words = pos
    return out
  }
  if (pos.length === 0 && (spec.dot === 'always' || (spec.dot === 'recursive' && recursive))) {
    pos.push('.')
  }
  const kind = noPattern && spec.kind === 'content' ? 'meta' : spec.kind
  for (const arg of pos) {
    if (kind === 'git') {
      out.match.push(arg)
      if (parsed.flags.has('--no-index')) out.check.push(arg)
      continue
    }
    out.check.push(arg)
    out.match.push(arg)
    if (kind === 'content' && (recursive || isGlobArg(arg))) {
      out.cover.push({ arg, subtree: recursive })
    }
  }
  return out
}

function analyzeFind(args: readonly string[]): Analysis | undefined {
  const out: Analysis = { check: [], match: [], cover: [], words: [] }
  let i = 0
  while (args[i] !== undefined && /^-[HLP]$/.test(args[i] as string)) i++
  let starts = 0
  while (args[i] !== undefined && !/^[-!(),]/.test(args[i] as string)) {
    out.check.push(args[i] as string)
    out.match.push(args[i] as string)
    starts++
    i++
  }
  if (starts === 0) {
    out.check.push('.')
    out.match.push('.')
  }
  for (; i < args.length; i++) {
    const token = args[i] as string
    if (FIND_BARE.has(token)) continue
    if (FIND_VALUE.has(token)) {
      if (args[i + 1] === undefined) return undefined
      i++
      continue
    }
    if (FIND_FILE.has(token)) {
      const file = args[i + 1]
      if (file === undefined) return undefined
      out.check.push(file)
      out.match.push(file)
      i++
      continue
    }
    return undefined
  }
  return out
}

function analyzeGit(args: readonly string[]): Analysis | undefined {
  const sub = args[0]
  const rest = args.slice(1)
  if (sub === undefined) return undefined
  const spec = Object.hasOwn(GIT_SPECS, sub) ? GIT_SPECS[sub] : undefined
  if (spec !== undefined) {
    const analysis = analyzeSpec(spec, rest)
    if (analysis === undefined) return undefined
    // `rev:path` and pathspec magic: only the part after the colon is a path
    analysis.match = analysis.match.map((a) => {
      const colon = a.indexOf(':')
      return colon === -1 ? a : a.slice(colon + 1)
    })
    const globs = analysis.match.filter(isGlobArg)
    analysis.cover = globs.map((arg) => ({ arg, subtree: false }))
    return analysis
  }
  const none: Analysis = { check: [], match: [], cover: [], words: [] }
  if (sub === 'branch') return rest.every((a) => GIT_BRANCH_FLAGS.has(a)) ? none : undefined
  if (sub === 'remote') {
    return rest.length === 1 && (rest[0] === '-v' || rest[0] === '--verbose') ? none : undefined
  }
  return undefined
}

/** Names of the commands that have a built-in grammar. */
export const READ_ONLY_COMMAND_NAMES: readonly string[] = [
  ...Object.keys(SPECS),
  'echo',
  'node',
  'bun',
  'find',
  'git',
]

/** Which commands are considered: a subset of {@link READ_ONLY_COMMAND_NAMES}; default all. */
export type CommandFilter = ReadonlySet<string> | undefined

/** Analyse one normalised subcommand; `undefined` when it is not read-only. */
function analyze(words: readonly string[], filter?: CommandFilter): Analysis | undefined {
  const name = words[0]
  if (name === undefined) return undefined
  if (filter !== undefined && !filter.has(name)) return undefined
  const args = words.slice(1)
  const none: Analysis = { check: [], match: [], cover: [], words: [] }
  switch (name) {
    case 'echo':
      return { ...none, words: [...args] }
    case 'node':
    case 'bun':
      return args.length === 1 && (args[0] === '--version' || args[0] === '-v') ? none : undefined
    case 'find':
      return analyzeFind(args)
    case 'git':
      return analyzeGit(args)
    default: {
      const spec = Object.hasOwn(SPECS, name) ? SPECS[name] : undefined
      return spec === undefined ? undefined : analyzeSpec(spec, args)
    }
  }
}

const words = (subcommand: string): string[] => subcommand.split(' ').filter((w) => w !== '')

/** Redirecting to the null device does not write anything. */
const NULL_DEVICE = '/dev/null'

/** True for one normalised subcommand (`ls -la`) that only reads. */
export function isReadOnlySubcommand(subcommand: string, filter?: CommandFilter): boolean {
  return analyze(words(subcommand), filter) !== undefined
}

/**
 * True when the whole command line only reads: every subcommand is on the allowlist and accepted
 * by its grammar, the command is not complex and it redirects nowhere (except to `/dev/null`).
 *
 * @param command - Raw command line.
 * @param filter - Only these command names count as read-only (default: every built-in grammar).
 */
export function isReadOnlyCommand(command: string, filter?: CommandFilter): boolean {
  const parsed = parseCommand(command)
  if (parsed.complex || parsed.subcommands.length === 0) return false
  if (parsed.redirects.some((target) => target !== NULL_DEVICE)) return false
  return parsed.subcommands.every((sub) => isReadOnlySubcommand(sub, filter))
}

/** Path-like arguments of one read-only subcommand (see {@link readPathArguments}). */
export interface ReadPaths {
  /** Arguments that must resolve inside a working directory (and are matched against rules). */
  check: string[]
  /** Arguments matched against `Read` rules only (git pathspecs: they stay inside the repo). */
  match: string[]
  /**
   * True when an argument cannot be resolved lexically: any `$` expansion or backtick in ANY
   * argument, `~user` or brace expansion in a path argument.
   */
  unsafe: boolean
  /** Arguments whose content is read through a directory (recursion) or a glob. */
  cover: Cover[]
}

/** A `$name`, `${…}`, `$(…`, `$'…'` or `$"…"` expansion (a bare trailing `$` is a regex anchor). */
const EXPANSION = /\$[A-Za-z_{(0-9@*#?!$'"-]/

/**
 * Path-like arguments of one normalised read-only subcommand, for the path guard, from the same
 * grammar that accepted it (`find` contributes its start paths, default `.`; recursive `grep` and
 * `rg` without a path work on `.`; git pathspecs and `rev:path` are matched against `Read`
 * rules). Pure text analysis. A subcommand that is not read-only yields no paths.
 *
 * @param subcommand - One subcommand as returned by `parseCommand`.
 * @param filter - Only these command names count as read-only (default: every built-in grammar).
 */
export function readPathArguments(subcommand: string, filter?: CommandFilter): ReadPaths {
  const all = words(subcommand)
  const out: ReadPaths = { check: [], match: [], unsafe: false, cover: [] }
  if (all.slice(1).some((a) => EXPANSION.test(a) || a.includes('`'))) out.unsafe = true
  const analysis = analyze(all, filter)
  if (analysis === undefined) return out
  const pathLike = (arg: string): boolean => {
    if (arg.includes('{') || (arg.startsWith('~') && arg !== '~' && !arg.startsWith('~/'))) {
      out.unsafe = true
      return false
    }
    return true
  }
  out.check = analysis.check.filter(pathLike)
  out.match = analysis.match.filter(pathLike)
  out.cover = analysis.cover.filter((c) => pathLike(c.arg))
  return out
}
