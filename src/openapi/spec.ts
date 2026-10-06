/**
 * OpenAPI document loading, local `$ref` resolution and schema summarization for
 * `eharness/openapi`. Pure functions; no I/O.
 *
 * @see docs/specs/17-openapi-plugin.md
 */
import { HarnessError } from '../index.ts'

/** A JSON object. */
export type Json = Record<string, unknown>

/** Schema summarization limits. */
export interface SchemaLimits {
  maxDepth: number
  maxDescriptionChars: number
  /** Approximate serialized size cap of the schemas of one tool; beyond it subschemas are cut. */
  maxSchemaBytes: number
}

/** The size budget shared by every schema of one tool (see {@link SchemaLimits.maxSchemaBytes}). */
export interface SchemaBudget {
  left: number
  truncated: boolean
}

export function invalid(message: string): never {
  throw new HarnessError('EH_CONFIG_INVALID', message)
}

export function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse and validate the document (OpenAPI 3.0.x / 3.1.x JSON only). */
export function loadSpec(spec: unknown, at: string): Json {
  let doc: unknown = spec
  if (typeof spec === 'string') {
    try {
      doc = JSON.parse(spec)
    } catch {
      invalid(
        `${at}: the spec string is not valid JSON. YAML is not supported (no YAML dependency); convert it to JSON first (e.g. \`yq -o=json . openapi.yaml\`).`,
      )
    }
  }
  if (!isObject(doc)) invalid(`${at}: the spec must be a parsed OpenAPI object or a JSON string.`)
  if (typeof doc.swagger === 'string') {
    invalid(
      `${at}: Swagger ${doc.swagger} is not supported; convert the document to OpenAPI 3.0 or 3.1.`,
    )
  }
  if (typeof doc.openapi !== 'string' || !/^3\.[01]\.\d+/.test(doc.openapi)) {
    invalid(`${at}: \`openapi\` must be 3.0.x or 3.1.x (got '${String(doc.openapi)}').`)
  }
  if (!isObject(doc.paths)) invalid(`${at}: the spec has no \`paths\` object.`)
  assertLocalRefs(doc, at)
  return doc
}

/** Fail on any `$ref` that is not local (`#/…`): nothing is fetched at load. */
function assertLocalRefs(root: Json, at: string): void {
  const seen = new Set<object>()
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null || seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') {
        if (!value.startsWith('#/')) {
          invalid(
            `${at}: remote $ref '${value}' is not supported (only local '#/…' references; nothing is fetched). Bundle the document first.`,
          )
        }
      } else walk(value)
    }
  }
  walk(root)
}

/** Resolve a local JSON pointer (`#/components/schemas/Pet`). */
export function resolvePointer(doc: Json, ref: string, at: string): unknown {
  let node: unknown = doc
  for (const raw of ref.slice(2).split('/')) {
    const key = decodeURIComponent(raw).replaceAll('~1', '/').replaceAll('~0', '~')
    if (Array.isArray(node)) node = node[Number(key)]
    else if (isObject(node)) node = node[key]
    else node = undefined
    if (node === undefined) invalid(`${at}: $ref '${ref}' does not resolve.`)
  }
  return node
}

/** Follow `$ref` chains of a non-schema object (parameter, request body). */
export function deref<T = Json>(doc: Json, value: unknown, at: string): T {
  let current = value
  for (let hops = 0; isObject(current) && typeof current.$ref === 'string'; hops++) {
    if (hops > 20) invalid(`${at}: $ref chain is too long.`)
    current = resolvePointer(doc, current.$ref, at)
  }
  return current as T
}

/** Trim and cap a description to `max` characters (`undefined` when empty). */
export function capText(text: unknown, max: number): string | undefined {
  if (typeof text !== 'string') return undefined
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  return trimmed.length > max ? `${trimmed.slice(0, Math.max(0, max - 1))}…` : trimmed
}

const COPY = [
  'type',
  'format',
  'enum',
  'const',
  'default',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
  'multipleOf',
  'minProperties',
  'maxProperties',
] as const

/**
 * Summarize an OpenAPI schema into a small JSON Schema: local refs resolved, cycles and depth
 * overruns become `{}` with a description, 3.0 `nullable` becomes a type union, unsupported
 * keywords (`discriminator`, `xml`, `example`, `externalDocs`, …) are dropped.
 */
export function summarizeSchema(
  doc: Json,
  schema: unknown,
  limits: SchemaLimits,
  at: string,
  opts: { request?: boolean; budget?: SchemaBudget } = {},
): Json {
  const budget = opts.budget ?? { left: limits.maxSchemaBytes, truncated: false }
  /** Pointers resolved during this call: a ref used many times is looked up once. */
  const resolved = new Map<string, unknown>()
  const walk = (node: unknown, depth: number, stack: readonly string[]): Json => {
    if (!isObject(node)) return {}
    if (typeof node.$ref === 'string') {
      const ref = node.$ref
      if (stack.includes(ref) || depth > limits.maxDepth) {
        return { description: `(recursive: ${ref})` }
      }
      if (!resolved.has(ref)) resolved.set(ref, resolvePointer(doc, ref, at))
      return walk(resolved.get(ref), depth, [...stack, ref])
    }
    if (depth > limits.maxDepth) return { description: '(too deep: schema truncated)' }
    if (budget.left <= 0) {
      budget.truncated = true
      return { description: '(omitted: the schema is too large)' }
    }
    const out: Json = {}
    for (const key of COPY) if (node[key] !== undefined) out[key] = node[key]
    const description = capText(node.description, limits.maxDescriptionChars)
    if (description !== undefined) out.description = description
    // 3.0 exclusive bounds are booleans next to minimum / maximum
    for (const [flag, bound] of [
      ['exclusiveMinimum', 'minimum'],
      ['exclusiveMaximum', 'maximum'],
    ] as const) {
      const value = node[flag]
      if (typeof value === 'number') out[flag] = value
      else if (value === true && typeof node[bound] === 'number') {
        out[flag] = node[bound]
        delete out[bound]
      }
    }
    budget.left -= JSON.stringify(out).length
    if (node.nullable === true) {
      if (Array.isArray(out.type)) out.type = [...new Set([...out.type, 'null'])]
      else if (typeof out.type === 'string') out.type = [out.type, 'null']
      if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null]
    }
    if (node.items !== undefined) out.items = walk(node.items, depth + 1, stack)
    if (isObject(node.properties)) {
      const properties: Json = {}
      const dropped = new Set<string>()
      for (const [name, value] of Object.entries(node.properties)) {
        const resolved = deref(doc, value, at)
        if (opts.request === true && isObject(resolved) && resolved.readOnly === true) {
          dropped.add(name)
          continue
        }
        budget.left -= name.length + 4
        properties[name] = walk(value, depth + 1, stack)
      }
      out.properties = properties
      if (Array.isArray(node.required)) {
        const required = node.required.filter(
          (n): n is string => typeof n === 'string' && !dropped.has(n),
        )
        if (required.length > 0) out.required = required
      }
    }
    if (typeof node.additionalProperties === 'boolean') {
      out.additionalProperties = node.additionalProperties
    } else if (isObject(node.additionalProperties)) {
      out.additionalProperties = walk(node.additionalProperties, depth + 1, stack)
    }
    for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
      const list = node[key]
      if (Array.isArray(list)) out[key] = list.map((item) => walk(item, depth + 1, stack))
    }
    return out
  }
  return walk(schema, 0, [])
}
