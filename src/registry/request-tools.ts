/**
 * Request-scoped client tools and page context (internal + public types): validation of what a
 * request declares, the AI SDK tools built from it, and the page context block of the turn
 * reminder. Everything here is untrusted input (spec 11 §7.1, ADR-0028).
 *
 * @see docs/specs/11-interaction.md#71-request-scoped-client-tools-and-page-context
 * @see docs/decisions/0028-request-scoped-client-tools-and-page-context.md
 */
import { type JSONSchema7, type JSONValue, jsonSchema, type Tool, tool } from 'ai'
import { HarnessError, type HarnessWarning } from '../errors.ts'
import { neutralizeTags } from '../messages/framing.ts'
import { CLIENT_TOOL_TIMED_OUT, PAGE_CONTEXT_PREAMBLE } from '../messages/texts.ts'
import type { WaitTimeoutResult } from '../messages/types.ts'
import { TOOL_NAME_PATTERN } from './static.ts'
import { RESERVED_TOOL_NAMES } from './types.ts'

/** A client tool a request declares (name, description, JSON Schema input). */
export interface ClientToolDeclaration {
  name: string
  description?: string
  inputSchema: JSONSchema7
}

/** Limits and filters of request-scoped client tools (`SendOptions.clientToolsOptions`). */
export interface ClientToolsOptions {
  /** Names that may be declared (a list), or a predicate. Default: every valid name. */
  allow?: string[] | ((declaration: ClientToolDeclaration) => boolean)
  /** Most tools per request. Default 16. */
  maxTools?: number
  /** Most JSON bytes of one input schema. Default 8 192. */
  maxSchemaBytes?: number
  /** A call the client never answers expires after this many ms (default: never). */
  timeoutMs?: number
  /** The result an expired call takes. Default `{ errorText: CLIENT_TOOL_TIMED_OUT }`. */
  onTimeout?: WaitTimeoutResult
}

/** One block of page context a request provides. */
export interface PageContextEntry {
  /** What the value is (a short label, at most 200 characters, shown as an attribute). */
  description: string
  /** The data: a string, or JSON (stringified). */
  value: JSONValue | string
}

/** Limits of page context (`SendOptions.pageContextOptions`). */
export interface PageContextOptions {
  /** Total characters of all values. Default 4 000. */
  maxChars?: number
}

export const DEFAULT_MAX_CLIENT_TOOLS = 16
export const DEFAULT_MAX_SCHEMA_BYTES = 8_192
export const DEFAULT_PAGE_CONTEXT_CHARS = 4_000
/** Characters of a client tool description kept (the rest is cut). */
export const MAX_DESCRIPTION_CHARS = 1_000
/** Characters of a page context description kept. */
export const MAX_CONTEXT_LABEL_CHARS = 200
/** Most page context entries per request. */
export const MAX_CONTEXT_ENTRIES = 32
/** Deepest nesting and most nodes a declared schema may have (guards the walk, not the model). */
const MAX_SCHEMA_DEPTH = 32
const MAX_SCHEMA_NODES = 10_000

/** Harness-side definition of one request tool of a turn. */
export interface RequestToolMeta {
  timeoutMs?: number
  onTimeout: WaitTimeoutResult
}

/** The validated request tools of a turn, sorted by name. */
export interface BuiltRequestTools {
  tools: Array<{ name: string; tool: Tool }>
  meta: ReadonlyMap<string, RequestToolMeta>
  /** Stable signature of the declaration set (cache-bust detection across turns). */
  signature: string
}

function invalid(
  reason: string,
  message: string,
  extra: Record<string, unknown> = {},
): HarnessError {
  return new HarnessError('EH_INVALID_INPUT', message, { details: { reason, ...extra } })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Keywords whose value maps names to schemas. */
const NAME_MAPS: ReadonlySet<string> = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
])

/** Names a client can never take: they would reach the prototype of a plain record. */
const PROTOTYPE_NAMES: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

/** `text` cut to at most `max` UTF-16 units without splitting a surrogate pair. */
function sliceChars(text: string, max: number): string {
  if (text.length <= max) return text
  let end = Math.max(0, max)
  const last = text.charCodeAt(end - 1)
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end--
  return text.slice(0, end)
}

/** The last `max` UTF-16 units of `text` without starting inside a surrogate pair. */
function sliceTail(text: string, max: number): string {
  if (max <= 0) return ''
  if (text.length <= max) return text
  let start = text.length - max
  const first = text.charCodeAt(start)
  if (first >= 0xdc00 && first <= 0xdfff) start++
  return text.slice(start)
}

/** The first `$ref` that is not a pointer into the document, or a reason the walk gave up. */
function schemaProblem(schema: unknown): string | undefined {
  let nodes = 0
  const walk = (node: unknown, depth: number): string | undefined => {
    if (depth > MAX_SCHEMA_DEPTH) return 'is nested too deeply'
    if (++nodes > MAX_SCHEMA_NODES) return 'has too many nodes'
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item, depth + 1)
        if (found !== undefined) return found
      }
      return undefined
    }
    if (!isRecord(node)) return undefined
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && !(typeof value === 'string' && value.startsWith('#'))) {
        return 'has a `$ref` outside the document'
      }
      if (key === '$dynamicRef' || key === '$recursiveRef') {
        return `has a \`${key}\` (dynamic references are not supported)`
      }
      if (NAME_MAPS.has(key) && isRecord(value)) {
        // the keys of these maps are names (a property may be called `$ref`), not keywords
        for (const sub of Object.values(value)) {
          const found = walk(sub, depth + 2)
          if (found !== undefined) return found
        }
        continue
      }
      const found = walk(value, depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  return walk(schema, 0)
}

const encoder = new TextEncoder()

/**
 * Validate request-declared client tools and build them (spec 11 §7.1 rules 2–4): all or nothing,
 * `EH_INVALID_INPUT` with `details: { reason: 'client-tools', names, problems }`. `taken` holds
 * the names of every server tool of the turn (static, skill, source, deferred, `tool_search`) plus
 * any name the server reserves for itself (the output tool).
 */
export function buildRequestTools(
  declared: unknown,
  taken: ReadonlySet<string>,
  options: ClientToolsOptions = {},
): BuiltRequestTools | undefined {
  if (declared === undefined || declared === null) return undefined
  const maxTools = options.maxTools ?? DEFAULT_MAX_CLIENT_TOOLS
  const maxBytes = options.maxSchemaBytes ?? DEFAULT_MAX_SCHEMA_BYTES
  const fail = (problems: string[], names: string[]): never => {
    throw invalid(
      'client-tools',
      `The client tool declarations were rejected: ${problems.slice(0, 5).join('; ')}.`,
      { names: names.slice(0, 20), problems: problems.slice(0, 20) },
    )
  }
  if (!Array.isArray(declared)) return fail(['`clientTools` must be an array'], [])
  if (declared.length === 0) return undefined
  if (declared.length > maxTools) {
    return fail([`${declared.length} tools declared, at most ${maxTools} are allowed`], [])
  }
  const problems: string[] = []
  const bad: string[] = []
  const seen = new Set<string>()
  const built: Array<{ name: string; tool: Tool; description: string; schema: JSONSchema7 }> = []
  for (const raw of declared as unknown[]) {
    const label = isRecord(raw) && typeof raw.name === 'string' ? raw.name.slice(0, 64) : '?'
    const problem = (text: string): void => {
      problems.push(`'${label}' ${text}`)
      bad.push(label)
    }
    if (!isRecord(raw) || typeof raw.name !== 'string') {
      problem('is not a declaration with a string `name`')
      continue
    }
    const name = raw.name
    if (!TOOL_NAME_PATTERN.test(name)) {
      problem(`must match ${String(TOOL_NAME_PATTERN)}`)
      continue
    }
    if (PROTOTYPE_NAMES.has(name)) {
      problem('is a reserved name')
      continue
    }
    if (RESERVED_TOOL_NAMES.includes(name) || taken.has(name)) {
      problem('collides with a server tool or a reserved name')
      continue
    }
    if (seen.has(name)) {
      problem('is declared twice')
      continue
    }
    seen.add(name)
    if (raw.description !== undefined && typeof raw.description !== 'string') {
      problem('has a `description` that is not a string')
      continue
    }
    const schemaRaw = raw.inputSchema
    if (!isRecord(schemaRaw) || schemaRaw.type !== 'object') {
      problem('needs an `inputSchema` of `type: "object"`')
      continue
    }
    let json: string
    try {
      json = JSON.stringify(schemaRaw)
    } catch {
      problem('has an `inputSchema` that is not JSON')
      continue
    }
    if (encoder.encode(json).length > maxBytes) {
      problem(`has an \`inputSchema\` over ${maxBytes} bytes`)
      continue
    }
    const walked = schemaProblem(schemaRaw)
    if (walked !== undefined) {
      problem(`has an \`inputSchema\` that ${walked}`)
      continue
    }
    const declaration: ClientToolDeclaration = {
      name,
      inputSchema: JSON.parse(json) as JSONSchema7,
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    }
    const allow = options.allow
    let allowed = true
    if (Array.isArray(allow)) allowed = allow.includes(name)
    else if (typeof allow === 'function') {
      try {
        allowed = allow(declaration) === true
      } catch {
        allowed = false
      }
    }
    if (!allowed) {
      problem('is not allowed')
      continue
    }
    const description = sliceChars(declaration.description ?? '', MAX_DESCRIPTION_CHARS)
    built.push({
      name,
      description,
      schema: declaration.inputSchema,
      // no `execute`: a call parks as a client tool call; no metadata: risk `unknown` (rule 3)
      tool: tool({
        ...(description === '' ? {} : { description }),
        inputSchema: jsonSchema(declaration.inputSchema),
      } as never) as Tool,
    })
  }
  if (problems.length > 0) return fail(problems, bad)
  built.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const onTimeout: WaitTimeoutResult = options.onTimeout ?? { errorText: CLIENT_TOOL_TIMED_OUT }
  const meta = new Map<string, RequestToolMeta>()
  for (const { name } of built) {
    meta.set(name, {
      onTimeout,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    })
  }
  return {
    tools: built.map(({ name, tool }) => ({ name, tool })),
    meta,
    signature: JSON.stringify(built.map((b) => [b.name, b.description, b.schema])),
  }
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replace(/\s+/g, ' ')
}

/** `escapeAttribute(text)`, cut (before escaping a character, never inside an entity) to `max`. */
function fitEscaped(text: string, max: number): string {
  let out = ''
  for (const char of text) {
    // whitespace runs collapse to one space: escape the running string, not each character
    if (escapeAttribute(out + char).length > max) break
    out += char
  }
  return escapeAttribute(out)
}

/** Share `max` characters among texts: short texts keep everything, the rest share evenly. */
function shares(lengths: readonly number[], max: number): number[] {
  const order = lengths.map((length, i) => ({ length, i })).sort((a, b) => a.length - b.length)
  const out = new Array<number>(lengths.length).fill(0)
  let remaining = max
  for (const [k, { length, i }] of order.entries()) {
    const share = Math.floor(remaining / (order.length - k))
    out[i] = Math.min(length, share)
    remaining -= out[i] as number
  }
  return out
}

/** Cut `text` to at most `max` characters, keeping head and tail around a marker. */
function trimMiddle(text: string, max: number): string {
  if (text.length <= max) return text
  const marker = (omitted: number): string => `\n[… ${omitted} characters omitted …]\n`
  let available = max - marker(text.length).length
  if (available < 20) return sliceChars(text, max)
  available = max - marker(text.length - available).length
  const head = Math.ceil(available / 2)
  const tail = available - head
  const start = sliceChars(text, head)
  const end = sliceTail(text, tail)
  return `${start}${marker(text.length - start.length - end.length)}${end}`
}

/**
 * The page context block of the turn reminder (spec 11 §7.1 rule 6): the fixed preamble, then one
 * `<page-context description="…">` block per entry. Values are data: the `page-context` and
 * `system-reminder` tags are neutralised inside them and the total is capped. Invalid entries are
 * `EH_INVALID_INPUT` (`details.reason: 'page-context'`).
 */
export function renderPageContext(
  entries: unknown,
  options: PageContextOptions = {},
  warn?: (warning: HarnessWarning, key?: string) => void,
): string | undefined {
  if (entries === undefined || entries === null) return undefined
  if (!Array.isArray(entries)) {
    throw invalid('page-context', '`pageContext` must be an array of { description, value }.')
  }
  if (entries.length === 0) return undefined
  if (entries.length > MAX_CONTEXT_ENTRIES) {
    throw invalid(
      'page-context',
      `${entries.length} page context entries given, at most ${MAX_CONTEXT_ENTRIES} are allowed.`,
    )
  }
  const maxChars = options.maxChars ?? DEFAULT_PAGE_CONTEXT_CHARS
  const items: Array<{ description: string; text: string }> = []
  for (const raw of entries as unknown[]) {
    if (!isRecord(raw) || typeof raw.description !== 'string' || !('value' in raw)) {
      throw invalid(
        'page-context',
        'Every page context entry needs a string `description` and a `value`.',
      )
    }
    let text: string
    if (typeof raw.value === 'string') text = raw.value
    else {
      let json: string | undefined
      try {
        json = JSON.stringify(raw.value)
      } catch {
        json = undefined
      }
      if (json === undefined) {
        throw invalid('page-context', 'A page context `value` must be a string or JSON.')
      }
      text = json
    }
    items.push({
      description: sliceChars(raw.description, MAX_CONTEXT_LABEL_CHARS),
      text: neutralizeTags(text, ['page-context', 'system-reminder']),
    })
  }
  if (maxChars <= 0) return undefined
  let limited = 0
  // the escaped descriptions count toward `maxChars` too (at most half of it): the block is bounded
  const labels = items.map((item) => escapeAttribute(item.description))
  const labelShares = shares(
    labels.map((label) => label.length),
    Math.floor(maxChars / 2),
  )
  const kept = items.map((item, i) => {
    const label = fitEscaped(item.description, labelShares[i] as number)
    if (label.length !== (labels[i] as string).length) limited++
    return label
  })
  const budget = shares(
    items.map((item) => item.text.length),
    maxChars - kept.reduce((sum, label) => sum + label.length, 0),
  )
  const blocks = items.map((item, i) => {
    const text = trimMiddle(item.text, budget[i] as number)
    if (text.length !== item.text.length) limited++
    return `<page-context description="${kept[i]}">\n${text.replace(/\n$/, '')}\n</page-context>`
  })
  if (limited > 0) {
    warn?.(
      {
        code: 'W_PAGE_CONTEXT_LIMITED',
        message: `The page context was cut to ${maxChars} characters (${limited} of ${items.length} entries shortened).`,
        details: { maxChars, entries: items.length, limited },
      },
      'page-context',
    )
  }
  return [PAGE_CONTEXT_PREAMBLE, ...blocks].join('\n\n')
}
