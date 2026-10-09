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
