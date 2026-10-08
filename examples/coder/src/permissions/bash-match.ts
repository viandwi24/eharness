/**
 * Shell command analysis for permission rules: splits a command line into subcommands, strips
 * harmless wrappers and reports redirect targets. Parsing only; nothing here ever runs a command.
 */
import { parse } from 'shell-quote'

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
const GROUPING = new Set(['(', ')', '<(', ';;'])
const OUTPUT_REDIRECTS = new Set(['>', '>>', '&>', '&>>', '>|', '>&'])
const INPUT_REDIRECTS = new Set(['<', '<&', '<<<'])

const DURATION = /^\d+(\.\d+)?[smhd]?$/
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/

/**
 * Replace unquoted newlines with `;`, and report whether the text uses command substitution,
 * backticks or process substitution (or has an unterminated quote).
 */
function preprocess(command: string): { text: string; complex: boolean } {
  let out = ''
  let complex = false
  let single = false
  let double = false
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string
    const next = command[i + 1]
    if (single) {
      if (ch === "'") single = false
      out += ch
      continue
    }
    if (ch === '\\') {
      if (next === '\n') {
        i++
        continue
      }
      out += ch
      if (next !== undefined) {
        out += next
        i++
      }
      continue
    }
    if (ch === '$' && next === '(') complex = true
    if (ch === '`') complex = true
    if (double) {
      if (ch === '"') double = false
      out += ch
      continue
    }
    if (ch === "'") single = true
    else if (ch === '"') double = true
    else if ((ch === '<' || ch === '>') && next === '(') complex = true
    if (ch === '\n' || ch === '\r') {
      out += ' ; '
      continue
    }
    out += ch
  }
  if (single || double) complex = true
  return { text: out, complex }
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
  const pre = preprocess(command)
  let complex = pre.complex
  const subcommands: string[] = []
  const redirects: string[] = []
  const inputs: string[] = []
  let xargs = false
  let tokens: ReturnType<typeof parse>
  try {
    tokens = parse(pre.text, (name) => `$${name}`)
  } catch {
    return { subcommands: [], complex: true, redirects: [], inputs: [], xargs: false }
  }

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

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok === undefined) continue
    if (typeof tok === 'string') {
      cur.push(tok)
      continue
    }
    if ('comment' in tok) break
    const op = (tok as { op: string }).op
    if (op === 'glob') {
      cur.push((tok as { pattern: string }).pattern)
    } else if (SEPARATORS.has(op)) {
      flush(op)
    } else if (GROUPING.has(op)) {
      complex = true
      flush(op)
    } else if (OUTPUT_REDIRECTS.has(op)) {
      if (/^\d$/.test(cur[cur.length - 1] ?? '')) cur.pop()
      const target = tokens[i + 1]
      if (typeof target === 'string') {
        i++
        const fd = op === '>&' && (/^\d+$/.test(target) || target === '-')
        if (!fd) redirects.push(target)
      } else if (target !== undefined && (target as { op?: string }).op === 'glob') {
        i++
        redirects.push((target as { pattern: string }).pattern)
      } else {
        complex = true
      }
    } else if (INPUT_REDIRECTS.has(op)) {
      if (/^\d$/.test(cur[cur.length - 1] ?? '')) cur.pop()
      const target = tokens[i + 1]
      if (typeof target === 'string') {
        i++
        if (op === '<') inputs.push(target)
        else if (op === '<&' && !/^\d+$/.test(target) && target !== '-') inputs.push(target)
      } else if (target !== undefined && (target as { op?: string }).op === 'glob') {
        i++
        inputs.push((target as { pattern: string }).pattern)
      }
    } else {
      // heredocs (`<<`, `<<-`) and anything unknown
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
 * `builtin`, bare `xargs`, `noglob`) and safe env assignments, and collect redirect and input-redirect targets.
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
