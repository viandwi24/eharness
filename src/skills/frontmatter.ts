/**
 * `SKILL.md` frontmatter: a small, dependency-free YAML **subset** (spec 07 §8, CLAUDE.md rule 10).
 *
 * Supported:
 *
 * - `key: value` with plain scalars (strings, integers/floats, `true`/`false`, `null`/`~`) and
 *   single- or double-quoted strings (`''` escape; JSON escapes in double quotes);
 * - flow lists of scalars on one line: `key: [a, "b, c", 3]`;
 * - block lists of scalars: `key:` followed by `- item` lines (indented or not);
 * - block scalars for strings: `|`, `|-` (literal) and `>`, `>-` (folded), with plain indentation
 *   (no explicit indentation indicator, no `+` chomping);
 * - one level of nesting: `key:` followed by indented `sub: value` lines (scalars, flow lists or
 *   block scalars);
 * - blank lines, full-line `#` comments and ` #` trailing comments after plain values.
 *
 * Everything else (multi-line plain/quoted scalars, anchors/aliases/tags, flow maps, deeper
 * nesting, tabs in indentation, duplicate keys, the keys `__proto__`/`constructor`/`prototype`)
 * is rejected with an error message.
 *
 * @see docs/specs/07-skills.md#8-filesystem-autoload-in-eharnessfilesystem
 */
import type { SkillMeta } from '../registry/types.ts'
import { skillDescriptionError, skillNameError } from './define.ts'

/** A scalar value of the subset. */
export type FrontmatterScalar = string | number | boolean | null

/** A value of the subset: scalar, list of scalars, or (top level only) a map of those. */
export type FrontmatterValue =
  | FrontmatterScalar
  | FrontmatterScalar[]
  | { [key: string]: FrontmatterScalar | FrontmatterScalar[] }

type Result<T> = { ok: true; value: T } | { ok: false; error: string }

const KEY = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/
const NUMBER = /^[-+]?(?:\d+|\d*\.\d+|\d+\.\d*)(?:[eE][-+]?\d+)?$/
const RESERVED_START = /^[&*!|>%@`{[\]}"',?]/

function fail<T>(line: number, message: string): Result<T> {
  return { ok: false, error: `line ${line}: ${message}` }
}

/** Strip a ` #` comment from a plain value (quotes are handled by the caller). */
function stripComment(text: string): string {
  if (text.trimStart().startsWith('#')) return ''
  const index = text.search(/\s#/)
  return (index === -1 ? text : text.slice(0, index)).trimEnd()
}

function parsePlain(raw: string): Result<FrontmatterScalar> {
  const text = raw.trim()
  if (text === '' || text === '~' || text === 'null' || text === 'Null' || text === 'NULL') {
    return { ok: true, value: null }
  }
  if (text === 'true' || text === 'True' || text === 'TRUE') return { ok: true, value: true }
  if (text === 'false' || text === 'False' || text === 'FALSE') return { ok: true, value: false }
  if (NUMBER.test(text)) {
    const value = Number(text)
    if (Number.isFinite(value)) return { ok: true, value }
  }
  if (RESERVED_START.test(text) || text.startsWith('- ') || text === '-') {
    return { ok: false, error: `unsupported syntax '${text}'` }
  }
  if (/:(\s|$)/.test(text)) return { ok: false, error: `ambiguous ': ' in plain value '${text}'` }
  return { ok: true, value: text }
}

/**
 * Parse one quoted string starting at `text[0]`; returns the value and the rest after the
 * closing quote.
 */
function parseQuoted(text: string): Result<{ value: string; rest: string }> {
  const quote = text[0]
  if (quote === "'") {
    let out = ''
    for (let i = 1; i < text.length; i++) {
      const ch = text[i] as string
      if (ch === "'") {
        if (text[i + 1] === "'") {
          out += "'"
          i++
          continue
        }
        return { ok: true, value: { value: out, rest: text.slice(i + 1) } }
      }
      out += ch
    }
    return { ok: false, error: 'unterminated single-quoted string' }
  }
  for (let i = 1; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === '"') {
      try {
        const value = JSON.parse(text.slice(0, i + 1)) as string
        return { ok: true, value: { value, rest: text.slice(i + 1) } }
      } catch {
        return { ok: false, error: 'unsupported escape in double-quoted string' }
      }
    }
  }
  return { ok: false, error: 'unterminated double-quoted string' }
}

/** Parse a scalar (quoted or plain) that makes up the whole remaining value. */
function parseScalar(raw: string): Result<FrontmatterScalar> {
  const text = raw.trim()
  if (text.startsWith('"') || text.startsWith("'")) {
    const quoted = parseQuoted(text)
    if (!quoted.ok) return quoted
    const rest = quoted.value.rest.trim()
    if (rest !== '' && !rest.startsWith('#')) {
      return { ok: false, error: `unexpected text after quoted string: '${rest}'` }
    }
    return { ok: true, value: quoted.value.value }
  }
  return parsePlain(stripComment(text))
}

/** Parse `[a, "b", 3]` on one line. */
function parseFlowList(raw: string): Result<FrontmatterScalar[]> {
  let text = raw.trim()
  if (!text.startsWith('[')) return { ok: false, error: 'expected a flow list' }
  text = text.slice(1)
  const items: FrontmatterScalar[] = []
  for (;;) {
    text = text.trimStart()
    if (text.startsWith(']')) break
    if (text === '') return { ok: false, error: 'unterminated flow list' }
    if (text.startsWith('[') || text.startsWith('{')) {
      return { ok: false, error: 'nested collections are not supported' }
    }
    if (text.startsWith('"') || text.startsWith("'")) {
      const quoted = parseQuoted(text)
      if (!quoted.ok) return quoted
      items.push(quoted.value.value)
      text = quoted.value.rest.trimStart()
    } else {
      const end = text.search(/[,\]]/)
      if (end === -1) return { ok: false, error: 'unterminated flow list' }
      const item = parsePlain(text.slice(0, end))
      if (!item.ok) return item
      if (text.slice(0, end).trim() === '') return { ok: false, error: 'empty flow list item' }
      items.push(item.value)
      text = text.slice(end)
    }
    if (text.startsWith(',')) {
      text = text.slice(1)
      continue
    }
    if (text.startsWith(']')) break
    return { ok: false, error: 'expected , or ] in flow list' }
  }
  const rest = text.slice(1).trim()
  if (rest !== '' && !rest.startsWith('#')) {
    return { ok: false, error: `unexpected text after flow list: '${rest}'` }
  }
  return { ok: true, value: items }
}

/** Parse an inline value: flow list or scalar. */
function parseInline(raw: string): Result<FrontmatterScalar | FrontmatterScalar[]> {
  const text = raw.trim()
  if (text.startsWith('[')) return parseFlowList(text)
  return parseScalar(text)
}

interface Line {
  no: number
  indent: number
  text: string
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const BLOCK_HEADER = /^([|>])(-?)\s*(?:#.*)?$/

function splitKey(text: string): { key: string; rest: string } | undefined {
  const match = /^([^\s:#'"][^:]*?):(?:\s+(.*))?$/.exec(text)
  if (match === null) return undefined
  return { key: (match[1] as string).trim(), rest: match[2] ?? '' }
}

function keyError(key: string): string | undefined {
  if (!KEY.test(key)) return `unsupported key '${key}'`
  if (FORBIDDEN_KEYS.has(key)) return `forbidden key '${key}'`
  return undefined
}

function leadingSpaces(text: string): Result<number> {
  const leading = /^[ \t]*/.exec(text)?.[0] ?? ''
  if (leading.includes('\t')) return { ok: false, error: 'tabs are not allowed in indentation' }
  return { ok: true, value: leading.length }
}

/** Fold the lines of a `>` block scalar (YAML line folding). */
function fold(lines: readonly string[]): string {
  let out = ''
  let last: 'none' | 'text' | 'more' = 'none'
  let empty = 0
  for (const line of lines) {
    if (line === '') {
      empty++
      continue
    }
    const kind = line.startsWith(' ') || line.startsWith('\t') ? 'more' : 'text'
    if (last === 'none') out += '\n'.repeat(empty) + line
    else if (last === 'text' && kind === 'text')
      out += (empty > 0 ? '\n'.repeat(empty) : ' ') + line
    else out += `\n${'\n'.repeat(empty)}${line}`
    empty = 0
    last = kind
  }
  return out
}

/**
 * Parse the YAML-subset frontmatter text (without the `---` delimiters) into a record.
 *
 * @internal Exported for `parseSkillMarkdown` and tests.
 */
export function parseFrontmatter(yaml: string): Result<Record<string, FrontmatterValue>> {
  const raw = yaml.replace(/\r\n?/g, '\n').split('\n')
  let i = 0

  /** Next significant line (skips blank and comment lines), not consumed. */
  const peek = (): Result<Line | undefined> => {
    while (i < raw.length) {
      const text = raw[i] as string
      if (text.trim() === '' || text.trim().startsWith('#')) {
        i++
        continue
      }
      const indent = leadingSpaces(text)
      if (!indent.ok) return fail(i + 1, indent.error)
      return { ok: true, value: { no: i + 1, indent: indent.value, text: text.trim() } }
    }
    return { ok: true, value: undefined }
  }

  /** Read a block scalar body: raw lines indented deeper than `parent` (or blank). */
  const blockScalar = (header: RegExpExecArray, parent: number, no: number): Result<string> => {
    const body: string[] = []
    let base: number | undefined
    while (i < raw.length) {
      const text = raw[i] as string
      if (text.trim() === '') {
        body.push('')
        i++
        continue
      }
      const spaces = /^ */.exec(text)?.[0].length ?? 0
      if (spaces <= parent) break
      if (base === undefined) base = spaces
      if (spaces < base) return fail(i + 1, 'inconsistent block scalar indentation')
      body.push(text.slice(base))
      i++
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop()
    if (body.length === 0) return fail(no, 'empty block scalar')
    const text = header[1] === '|' ? body.join('\n') : fold(body)
    return { ok: true, value: header[2] === '-' ? text : `${text}\n` }
  }

  /** Parse the value after `key:` (inline, block scalar); `undefined` = nothing inline. */
  const value = (
    rest: string,
    parent: number,
    no: number,
  ): Result<FrontmatterScalar | FrontmatterScalar[]> | undefined => {
    const header = BLOCK_HEADER.exec(rest.trim())
    if (header !== null) return blockScalar(header, parent, no)
    const trimmed = rest.trim()
    if (stripComment(rest) === '' && !trimmed.startsWith('"') && !trimmed.startsWith("'")) {
      return undefined
    }
    const parsed = parseInline(rest)
    return parsed.ok ? parsed : fail(no, parsed.error)
  }

  const out: Record<string, FrontmatterValue> = {}
  for (;;) {
    const peeked = peek()
    if (!peeked.ok) return peeked
    const line = peeked.value
    if (line === undefined) break
    if (line.indent !== 0) return fail(line.no, 'unexpected indentation')
    if (line.text === '---' || line.text === '...') return fail(line.no, 'multiple documents')
    const kv = splitKey(line.text)
    if (kv === undefined) return fail(line.no, `expected 'key: value', got '${line.text}'`)
    const badKey = keyError(kv.key)
    if (badKey !== undefined) return fail(line.no, badKey)
    if (Object.hasOwn(out, kv.key)) return fail(line.no, `duplicate key '${kv.key}'`)
    i++
    const inline = value(kv.rest, 0, line.no)
    if (inline !== undefined) {
      if (!inline.ok) return inline
      out[kv.key] = inline.value
      continue
    }
    // `key:` → block list, nested map, or null
    const firstPeek = peek()
    if (!firstPeek.ok) return firstPeek
    const first = firstPeek.value
    const isDash = (l: Line) => l.text === '-' || l.text.startsWith('- ')
    if (first === undefined || (first.indent === 0 && !isDash(first))) {
      out[kv.key] = null
      continue
    }
    if (isDash(first)) {
      const items: FrontmatterScalar[] = []
      for (;;) {
        const next = peek()
        if (!next.ok) return next
        const child = next.value
        if (child === undefined || (child.indent === 0 && !isDash(child))) break
        if (child.indent !== first.indent) return fail(child.no, 'inconsistent list indentation')
        if (!isDash(child)) return fail(child.no, 'expected a list item')
        const itemText = child.text.slice(1)
        if (itemText.trim().startsWith('[')) {
          return fail(child.no, 'nested collections are not supported')
        }
        const item = parseScalar(itemText)
        if (!item.ok) return fail(child.no, item.error)
        items.push(item.value)
        i++
      }
      out[kv.key] = items
      continue
    }
    const map: Record<string, FrontmatterScalar | FrontmatterScalar[]> = {}
    for (;;) {
      const next = peek()
      if (!next.ok) return next
      const child = next.value
      if (child === undefined || child.indent === 0) break
      if (child.indent !== first.indent) return fail(child.no, 'deeper nesting is not supported')
      const sub = splitKey(child.text)
      if (sub === undefined) return fail(child.no, `expected 'key: value', got '${child.text}'`)
      const badSub = keyError(sub.key)
      if (badSub !== undefined) return fail(child.no, badSub)
      if (Object.hasOwn(map, sub.key)) return fail(child.no, `duplicate key '${sub.key}'`)
      i++
      const subValue = value(sub.rest, child.indent, child.no)
      if (subValue === undefined) return fail(child.no, 'deeper nesting is not supported')
      if (!subValue.ok) return subValue
      map[sub.key] = subValue.value
    }
    out[kv.key] = map
  }
  return { ok: true, value: out }
}

function isPlainSafe(value: string): boolean {
  if (value === '' || value !== value.trim()) return false
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) < 0x20) return false
  if (/\s#|:(\s|$)|^#/.test(value)) return false
  if (value.includes(',') || value.includes('[') || value.includes(']')) return false
  const parsed = parsePlain(value)
  return parsed.ok && parsed.value === value
}

function serializeScalar(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'number')
    return Number.isFinite(value) ? String(value) : JSON.stringify(String(value))
  if (typeof value === 'string') return isPlainSafe(value) ? value : JSON.stringify(value)
  // outside the subset: shown as JSON text (display only, not parsed back)
  return JSON.stringify(JSON.stringify(value) ?? String(value))
}

function isScalar(value: unknown): value is FrontmatterScalar {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
}

function serializeInline(value: unknown): string {
  if (Array.isArray(value) && value.every(isScalar)) {
    return `[${value.map(serializeScalar).join(', ')}]`
  }
  if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
    return JSON.stringify(value) ?? 'null'
  }
  return serializeScalar(value)
}

/**
 * Serialize a record to the YAML subset (deterministic: keys in insertion order). Values the
 * subset cannot express (deep nesting, objects in lists) are written as JSON (valid YAML flow,
 * but not parsed back by {@link parseFrontmatter}).
 *
 * @internal Used for the `load_skill` summary and in tests.
 */
export function serializeFrontmatter(record: Record<string, unknown>): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue
    const shownKey = KEY.test(key) ? key : JSON.stringify(key)
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const entries = Object.entries(value).filter(([, v]) => v !== undefined)
      if (entries.length === 0) {
        lines.push(`${shownKey}: {}`)
        continue
      }
      lines.push(`${shownKey}:`)
      for (const [sub, subValue] of entries) {
        lines.push(`  ${KEY.test(sub) ? sub : JSON.stringify(sub)}: ${serializeInline(subValue)}`)
      }
      continue
    }
    lines.push(`${shownKey}: ${serializeInline(value)}`)
  }
  return lines.join('\n')
}

/**
 * Parse a `SKILL.md`: YAML-subset frontmatter between `---` lines, then the body.
 *
 * `name` and `description` are required and validated (spec 07 §1; the description is trimmed, so
 * a `>` block scalar carries no trailing newline); every other key goes to
 * `meta` (omitted when empty). The body has leading blank lines removed; line endings are
 * normalized to `\n`. Returns `{ error }` for a missing frontmatter, unsupported syntax or
 * invalid metadata (the filesystem source turns that into `W_INVALID_SKILL`).
 *
 * @example
 * ```ts
 * const parsed = parseSkillMarkdown('---\nname: pine-v6\ndescription: Pine v6.\n---\n# Pine\n')
 * if ('error' in parsed) console.warn(parsed.error)
 * else parsed.meta.name // 'pine-v6'
 * ```
 * @see docs/specs/07-skills.md#3-dynamic-skills--skillsource
 */
export function parseSkillMarkdown(
  text: string,
): { meta: SkillMeta; body: string } | { error: string } {
  if (typeof text !== 'string') return { error: 'SKILL.md must be text' }
  const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  if ((lines[0] ?? '').trimEnd() !== '---') {
    return { error: "SKILL.md must start with a '---' frontmatter block" }
  }
  const end = lines.findIndex((line, i) => i > 0 && line.trimEnd() === '---')
  if (end === -1) return { error: "the frontmatter block is not closed with '---'" }
  const parsed = parseFrontmatter(lines.slice(1, end).join('\n'))
  if (!parsed.ok) return { error: `invalid frontmatter: ${parsed.error}` }
  const { name, description, ...rest } = parsed.value
  const nameValue = typeof name === 'number' ? String(name) : name
  const nameError = skillNameError(nameValue)
  if (nameError !== undefined) return { error: nameError }
  const descriptionValue =
    typeof description === 'number' || typeof description === 'boolean'
      ? String(description)
      : typeof description === 'string'
        ? description.trim()
        : description
  const descriptionError = skillDescriptionError(descriptionValue)
  if (descriptionError !== undefined) return { error: descriptionError }
  const meta: SkillMeta = { name: nameValue as string, description: descriptionValue as string }
  if (Object.keys(rest).length > 0) meta.meta = rest
  const body = lines
    .slice(end + 1)
    .join('\n')
    .replace(/^\n+/, '')
  return { meta, body }
}
