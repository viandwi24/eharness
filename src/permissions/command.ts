/**
 * Shell command analysis for permission rules: splits a command line into subcommands, strips
 * harmless wrappers and reports redirect targets. Parsing only; nothing here ever runs a command.
 *
 * The tokenizer understands the POSIX subset that matters for a permission decision (words,
 * single and double quotes, backslash escapes, comments, the control and redirect operators,
 * `$(`, backticks) and is deliberately strict: anything it does not understand makes the command
 * `complex`, and a complex command is never auto-approved (spec 18 §6).
 */

/** Result of {@link parseCommand}. */
export interface ParsedCommand {
  /** Normalised subcommands (tokens joined by single spaces, wrappers stripped). */
  subcommands: string[]
  /**
   * True when the command uses substitution, subshells, groups, heredocs or control flow, ends in
   * a dangling operator, or could not be parsed. Allow rules never match a complex command.
   */
  complex: boolean
  /** Targets of `>`, `>>`, `2>`, `&>` and `tee` arguments. */
  redirects: string[]
  /** Targets of input redirects (`< file`, `0< file`); they read files without a command arg. */
  inputs: string[]
  /**
   * True when a subcommand ran through `xargs` (its stripped wrapper): its real arguments come from
   * stdin, so path analysis cannot see them.
   */
  xargs: boolean
}

/** Variables that do not change what a command does; `VAR=x cmd` is matched as `cmd`. */
const SAFE_ENV = new Set([
  'NODE_ENV',
  'CI',
  'FORCE_COLOR',
  'NO_COLOR',
  'LANG',
  'LC_ALL',
  'TZ',
  'DEBUG',
  'TERM',
  'COLORTERM',
])

const KEYWORDS = new Set([
  'for',
  'while',
  'until',
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'do',
  'done',
  'case',
  'esac',
  'select',
  'function',
  '{',
  '}',
])

/** Operators that end a subcommand and need a command after them. */
const NEEDS_NEXT = new Set(['&&', '||', '|', '|&'])
/** Operators that end a subcommand. */
const SEPARATORS = new Set(['&&', '||', ';', '|', '|&', '&'])
/** Operators that end a subcommand and make the command complex. */
const GROUPING = new Set(['(', ')', '<(', '>(', ';;'])
const OUTPUT_REDIRECTS = new Set(['>', '>>', '&>', '&>>', '>|', '>&'])
const INPUT_REDIRECTS = new Set(['<', '<&', '<<<'])

const DURATION = /^\d+(\.\d+)?[smhd]?$/
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/

/** Operators, longest first. */
const OPERATORS = [
  '&>>',
  ';;&',
  '<<<',
  '<<-',
  '&&',
  '||',
  ';;',
  ';&',
  '|&',
  '<(',
  '>(',
  '&>',
  '>>',
  '>&',
  '>|',
  '<&',
  '<>',
  '<<',
  '&',
  ';',
  '(',
  ')',
  '|',
  '<',
  '>',
] as const

type Token =
  | { kind: 'word'; text: string; start: number; end: number }
  | { kind: 'op'; text: string; start: number; end: number }

interface Tokenized {
  tokens: Token[]
  /** Substitution, unterminated quote or other construct we refuse to reason about. */
  complex: boolean
}

const isSpace = (ch: string): boolean => ch === ' ' || ch === '\t'
const isMeta = (ch: string): boolean => '|&;()<>'.includes(ch)

/** Split a command line into words and operators (see the file comment for the subset). */
function tokenize(command: string): Tokenized {
  const tokens: Token[] = []
  let complex = false
  let i = 0
  const n = command.length
  while (i < n) {
    const ch = command[i] as string
    if (isSpace(ch)) {
      i++
      continue
    }
    if (ch === '\\' && command[i + 1] === '\n') {
      i += 2
      continue
    }
    if (ch === '\n' || ch === '\r') {
      tokens.push({ kind: 'op', text: ';', start: i, end: i + 1 })
      i++
      continue
    }
    if (ch === '#') {
      while (i < n && command[i] !== '\n') i++
      continue
    }
    const op = isMeta(ch) ? OPERATORS.find((o) => command.startsWith(o, i)) : undefined
    if (op !== undefined) {
      tokens.push({ kind: 'op', text: op, start: i, end: i + op.length })
      i += op.length
      continue
    }
    // a word
    const start = i
    let text = ''
    while (i < n) {
      const c = command[i] as string
      if (isSpace(c) || c === '\n' || c === '\r' || isMeta(c)) break
      if (c === '\\') {
        const next = command[i + 1]
        if (next === '\n') {
          i += 2
          continue
        }
        if (next !== undefined) text += next
        i += 2
        continue
      }
      if (c === "'") {
        const end = command.indexOf("'", i + 1)
        if (end === -1) {
          complex = true
          text += command.slice(i + 1)
          i = n
        } else {
          text += command.slice(i + 1, end)
          i = end + 1
        }
        continue
      }
      if (c === '"') {
        i++
        let closed = false
        while (i < n) {
          const d = command[i] as string
          if (d === '"') {
            closed = true
            i++
            break
          }
          if (d === '\\') {
            const next = command[i + 1]
            if (next === '\n') {
              i += 2
              continue
            }
            if (next === '"' || next === '\\' || next === '$' || next === '`') {
              text += next
            } else if (next !== undefined) {
              text += `\\${next}`
            }
            i += 2
            continue
          }
          if (d === '`' || (d === '$' && command[i + 1] === '(')) complex = true
          text += d
          i++
        }
        if (!closed) complex = true
        continue
      }
      if (c === '`') complex = true
      if (c === '$') {
        const next = command[i + 1]
        // `$(…)` substitution, `$'…'` (ANSI-C) and `$"…"` change the word in ways we do not model
        if (next === '(' || next === "'" || next === '"') complex = true
      }
      text += c
      i++
    }
    tokens.push({ kind: 'word', text, start, end: i })
  }
  return { tokens, complex }
}

/** Strip leading wrappers and safe env assignments from one subcommand's tokens. */
function stripWrappers(tokens: string[]): string[] {
  let t = tokens
  for (;;) {
    const first = t[0]
    if (first === undefined) return t
    const assign = ASSIGNMENT.exec(first)
    if (assign !== null) {
      if (SAFE_ENV.has(assign[1] as string)) {
        t = t.slice(1)
        continue
      }
      return t
    }
    let rest: string[] | undefined
    switch (first) {
      case 'time':
      case 'nohup':
      case 'noglob':
        rest = t.slice(1)
        break
      case 'command':
      case 'builtin':
        if (t[1] !== undefined && !t[1].startsWith('-')) rest = t.slice(1)
        break
      case 'xargs':
        if (t[1] !== undefined && !t[1].startsWith('-')) rest = t.slice(1)
        break
      case 'nice': {
        let i = 1
        if (t[i] === '-n' && t[i + 1] !== undefined) i += 2
        else if (t[i] !== undefined && /^-\d+$/.test(t[i] as string)) i += 1
        rest = t.slice(i)
        break
      }
      case 'stdbuf': {
        let i = 1
        while (t[i]?.startsWith('-')) {
          i += /^-[ioe]$/.test(t[i] as string) ? 2 : 1
        }
        rest = t.slice(i)
        break
      }
      case 'timeout': {
        let i = 1
        while (t[i]?.startsWith('-')) {
          i += /^-[ks]$/.test(t[i] as string) ? 2 : 1
        }
        if (t[i] !== undefined && DURATION.test(t[i] as string)) rest = t.slice(i + 1)
        break
      }
      default:
        break
    }
    if (rest === undefined) return t
    t = rest
  }
}

/** Contents of `$(...)` and backtick substitutions (not quote-aware: over-extracts on purpose). */
function substitutions(command: string): string[] {
  const found: string[] = []
  for (let i = 0; i < command.length; i++) {
    if (command[i] === '$' && command[i + 1] === '(') {
      let depth = 1
      let j = i + 2
      for (; j < command.length && depth > 0; j++) {
        if (command[j] === '(') depth++
        else if (command[j] === ')') depth--
      }
      found.push(command.slice(i + 2, depth === 0 ? j - 1 : j))
    } else if (command[i] === '`') {
      const end = command.indexOf('`', i + 1)
      if (end === -1) {
        found.push(command.slice(i + 1))
        break
      }
      found.push(command.slice(i + 1, end))
      i = end
    }
  }
  return found
}

function parseOnce(command: string): ParsedCommand {
  const lexed = tokenize(command)
  let complex = lexed.complex
  const tokens = lexed.tokens
  const subcommands: string[] = []
  const redirects: string[] = []
  const inputs: string[] = []
  let xargs = false

  let cur: string[] = []
  /** Separator that preceded `cur` (undefined at the start). */
  let before: string | undefined

  const flush = (sep: string | undefined): void => {
    const words = stripWrappers(cur)
    if (words.length === 0) {
      // an empty command after a binary operator (`a && ; b`, dangling `a &&`) or a leading
      // binary operator (`&& a`)
      if (before !== undefined && NEEDS_NEXT.has(before)) complex = true
      if (sep !== undefined && NEEDS_NEXT.has(sep)) complex = true
    } else {
      if (cur.slice(0, cur.length - words.length).includes('xargs')) xargs = true
      const head = words[0] as string
      if (KEYWORDS.has(head)) complex = true
      if (head === 'tee') {
        for (const arg of words.slice(1)) if (!arg.startsWith('-')) redirects.push(arg)
      }
      subcommands.push(words.join(' ').replace(/\s+/g, ' ').trim())
    }
    cur = []
    before = sep
  }

  /** Drop a file-descriptor digit written right before a redirect (`2>`), as in `2>err`. */
  const dropFd = (op: Token, index: number): void => {
    const prev = tokens[index - 1]
    if (prev?.kind === 'word' && prev.end === op.start && /^\d$/.test(prev.text)) cur.pop()
  }

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] as Token
    if (tok.kind === 'word') {
      cur.push(tok.text)
      continue
    }
    const op = tok.text
    if (SEPARATORS.has(op)) {
      flush(op)
    } else if (GROUPING.has(op)) {
      complex = true
      flush(op)
    } else if (OUTPUT_REDIRECTS.has(op)) {
      dropFd(tok, i)
      const target = tokens[i + 1]
      if (target?.kind === 'word') {
        i++
        const fd = op === '>&' && (/^\d+$/.test(target.text) || target.text === '-')
        if (!fd) redirects.push(target.text)
      } else {
        complex = true
      }
    } else if (INPUT_REDIRECTS.has(op)) {
      dropFd(tok, i)
      const target = tokens[i + 1]
      if (target?.kind === 'word') {
        i++
        if (op === '<') inputs.push(target.text)
        else if (op === '<&' && !/^\d+$/.test(target.text) && target.text !== '-') {
          inputs.push(target.text)
        }
      }
    } else {
      // heredocs (`<<`, `<<-`), `<>`, `;&` and anything unknown
      complex = true
    }
  }
  flush(undefined)
  if (subcommands.length === 0) complex = true
  return { subcommands, complex, redirects, inputs, xargs }
}

/**
 * Split a shell command line into subcommands (`&&`, `||`, `;`, `|`, `|&`, `&`, newline), strip
 * leading wrappers (`timeout <n>`, `time`, `nice [-n x]`, `nohup`, `stdbuf <opts>`, `command`,
 * `builtin`, bare `xargs`, `noglob`) and safe env assignments, and collect redirect and
 * input-redirect targets.
 *
 * For a complex command the subcommands found inside `$(...)` and backticks are appended, so that
 * deny and ask rules also see them (allow rules never match a complex command).
 *
 * @param command - Raw command line as the model wrote it.
 */
export function parseCommand(command: string): ParsedCommand {
  const result = parseOnce(command)
  if (!result.complex) return result
  const seen = new Set<string>()
  const extra = (text: string, depth: number): void => {
    for (const body of substitutions(text)) {
      if (seen.has(body)) continue
      seen.add(body)
      const inner = parseOnce(body)
      result.subcommands.push(...inner.subcommands)
      result.redirects.push(...inner.redirects)
      result.inputs.push(...inner.inputs)
      if (inner.xargs) result.xargs = true
      if (depth < 3) extra(body, depth + 1)
    }
  }
  extra(command, 0)
  return result
}

// ─── deny / ask normalisation (spec 18 §5) ─────────────────────────────────────────────────────

/** Result of {@link restrictiveForms}. */
export interface RestrictiveForms {
  /**
   * Every subcommand of the command line plus, for each, the forms it takes once evasions are
   * undone (see {@link restrictiveForms}). Deny and ask rules match when any of them matches.
   */
  subcommands: string[]
  /** A `sh -c` / `eval` payload that could not be parsed: the command must ask. */
  unparseable: boolean
  /**
   * A command runs inline interpreter code (`python -c`, `node -e`, `perl -e`, `ruby -e`,
   * `php -r`): a broad allow rule must not approve it silently (spec 18 §7).
   */
  inlineCode: boolean
}

/** `xargs` options that take a separate value. */
const XARGS_VALUE_FLAGS = new Set(['-a', '-d', '-E', '-I', '-J', '-L', '-n', '-P', '-s'])
/** `flock` options that take a value. */
const FLOCK_VALUE_FLAGS = new Set(['-w', '-E', '-c'])
/** Interpreter programs and the flags that take inline code. */
const INLINE_FLAGS: Record<string, RegExp> = {
  python: /^-[a-zA-Z]*c[a-zA-Z]*$/,
  node: /^(-[ep]|--eval|--print)$/,
  nodejs: /^(-[ep]|--eval|--print)$/,
  bun: /^(-e|--eval|-p|--print)$/,
  deno: /^eval$/,
  perl: /^-[a-zA-Z]*[eE][a-zA-Z]*$/,
  ruby: /^-[a-zA-Z]*e[a-zA-Z]*$/,
  php: /^-r$/,
}

/** True when the tokens run an interpreter with inline code. */
function runsInlineCode(t: string[]): boolean {
  const program = (t[0] ?? '').replace(/[\d.]+$/, '')
  const flag = INLINE_FLAGS[program]
  return flag !== undefined && t.slice(1).some((w) => flag.test(w))
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
/** `sudo` / `doas` options that take a value. */
const SUDO_VALUE_FLAGS = new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U', '-r', '-t'])
/** `env` options that take a value. */
const ENV_VALUE_FLAGS = new Set(['-u', '-C', '-S', '-P'])
/** `git` global options that take a separate value (`-C dir`, `--git-dir dir`). */
const GIT_VALUE_FLAGS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--exec-path',
  '--config-env',
])
const MAX_NORMALISE_DEPTH = 4

/** Skip leading options of a wrapper (`-n`, `-u NAME`, …); `valueFlags` take the next word. */
function skipFlags(t: string[], from: number, valueFlags: ReadonlySet<string>): number {
  let i = from
  while (t[i]?.startsWith('-') === true && t[i] !== '-' && t[i] !== '--') {
    i += valueFlags.has(t[i] as string) ? 2 : 1
  }
  if (t[i] === '--') i++
  return i
}

/** Drop git global options before the subcommand: `git -C . -c x=y --no-pager push` → `git push`. */
function skipGitOptions(t: string[]): string[] {
  let i = 1
  while (t[i]?.startsWith('-') === true) {
    const flag = t[i] as string
    i += GIT_VALUE_FLAGS.has(flag) ? 2 : 1
  }
  return i === 1 ? t : ['git', ...t.slice(i)]
}

/**
 * Peel one subcommand down to what actually runs, collecting every form on the way. Never used to
 * widen an allow rule.
 */
function peel(tokens: string[], depth: number, out: RestrictiveForms): void {
  let t = tokens
  for (let guard = 0; guard < 12; guard++) {
    // history negation, leading control keywords and any env assignments
    while (t[0] !== undefined && (t[0] === '!' || KEYWORDS.has(t[0]) || ASSIGNMENT.test(t[0]))) {
      t = t.slice(1)
    }
    t = stripWrappers(t)
    const head = t[0]
    if (head === undefined) return
    // `/bin/rm`, `./rm` → `rm`
    const base =
      head.includes('/') && !head.endsWith('/') ? (head.split('/').pop() as string) : head
    if (base !== head) t = [base, ...t.slice(1)]
    let rest: string[] | undefined
    switch (base) {
      case 'sudo':
      case 'doas':
        rest = t.slice(skipFlags(t, 1, SUDO_VALUE_FLAGS))
        break
      case 'env':
        rest = t.slice(skipFlags(t, 1, ENV_VALUE_FLAGS))
        break
      case 'exec':
      case 'nohup':
      case 'command':
      case 'builtin':
      case 'time':
        rest = t.slice(skipFlags(t, 1, new Set(['-a'])))
        break
      case 'nice':
        rest = t.slice(skipFlags(t, 1, new Set(['-n'])))
        break
      case 'timeout': {
        const i = skipFlags(t, 1, new Set(['-k', '-s']))
        rest = t.slice(DURATION.test(t[i] ?? '') ? i + 1 : i)
        break
      }
      case 'xargs':
        rest = t.slice(skipFlags(t, 1, XARGS_VALUE_FLAGS))
        break
      case 'busybox':
      case 'setsid':
        rest = t.slice(skipFlags(t, 1, new Set()))
        break
      case 'flock': {
        const i = skipFlags(t, 1, FLOCK_VALUE_FLAGS)
        rest = t.slice(i + 1) // skip the lock file
        break
      }
      case 'find': {
        // `find … -exec|-execdir|-ok|-okdir <cmd…> ;|+`: the command is what runs
        const at = t.findIndex((w) => /^-(exec|execdir|ok|okdir)$/.test(w))
        if (at < 0) break
        let end = t.findIndex((w, i) => i > at && (w === '+' || w === ';' || w === '\\;'))
        if (end < 0) end = t.length
        const run = t.slice(at + 1, end)
        // the part after the terminator may hold another -exec: peel it as its own find
        if (end + 1 < t.length) peel(['find', ...t.slice(end + 1)], depth + 1, out)
        rest = run
        break
      }
      default:
        break
    }
    if (rest !== undefined && rest.length === 0) {
      out.subcommands.push(t.join(' '))
      return
    }
    if (rest !== undefined) {
      out.subcommands.push(rest.join(' '))
      t = rest
      continue
    }
    if (base === 'eval' || SHELLS.has(base)) {
      let payload: string[] | undefined
      if (base === 'eval') payload = t.slice(1)
      else {
        const c = t.findIndex((w, i) => i > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w))
        if (c >= 0) payload = t.slice(c + 1)
      }
      if (payload !== undefined) {
        if (payload.length === 0 || depth >= MAX_NORMALISE_DEPTH) {
          out.unparseable = true
          return
        }
        const inner = parseCommand(payload.join(' '))
        if (inner.subcommands.length === 0) out.unparseable = true
        for (const sub of inner.subcommands) {
          out.subcommands.push(sub)
          peel(sub.split(' '), depth + 1, out)
        }
      }
    }
    if (base === 'git') t = skipGitOptions(t)
    if (runsInlineCode(t)) out.inlineCode = true
    out.subcommands.push(t.join(' '))
    return
  }
}

/**
 * The subcommands of a command line as deny and ask rules should see them. Besides the parsed
 * subcommands, each one also appears with the usual evasions undone: a leading `!`, an absolute
 * or relative program path reduced to its name (`/bin/rm` → `rm`), git global options removed
 * (`git -C . -c x=y --no-pager push` → `git push`), wrappers looked through (`xargs [flags]`, `find … -exec|-execdir … ;|+`, `busybox`, `setsid`, `flock <file>`, `sudo`, `doas`,
 * `env [VAR=x…]`, `exec`, `nice`, `timeout <n>`, `nohup`, `command`, `builtin`, `time`) and the
 * payload of `sh|bash|zsh|dash|ksh -c '…'` and `eval '…'` parsed with the same parser. A payload
 * that cannot be parsed sets `unparseable`. Only for restricting rules: allow rules keep using
 * {@link parseCommand}, so none of this can widen an approval.
 *
 * @param command - Raw command line as the model wrote it.
 */
export function restrictiveForms(command: string): RestrictiveForms {
  const parsed = parseCommand(command)
  const out: RestrictiveForms = {
    subcommands: [...parsed.subcommands],
    unparseable: false,
    inlineCode: false,
  }
  for (const sub of parsed.subcommands) peel(sub.split(' '), 0, out)
  out.subcommands = [...new Set(out.subcommands.filter((s) => s !== ''))]
  return out
}
