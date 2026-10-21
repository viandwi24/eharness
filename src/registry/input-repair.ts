/**
 * Conservative input repair against a tool's JSON Schema, in two places: before `execute` for
 * `jsonSchema()` tools (MCP, which the AI SDK does not validate) and, for every tool, as the
 * AI SDK `repairToolCall` of an input that failed validation (zod tools).
 *
 * - a JSON-encoded string sent for an `object`/`array` property is parsed;
 * - a number or boolean sent where only `string` is declared becomes its string form (not past
 *   `maxLength`);
 * - a clean finite number string sent where only `number`/`integer` is declared becomes the number;
 * - arrays apply the rules per item (`items`).
 *
 * Values whose type the schema already allows, untyped properties and invalid JSON are never touched.
 *
 * @see docs/specs/09-tools-and-mcp.md#42-input-repair
 */
import { asSchema, type Tool } from 'ai'

type Json = Record<string, unknown>

/** How many levels of nested object properties are visited (the top level is level 0). */
const MAX_DEPTH = 2

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The declared types of a schema, `anyOf`/`oneOf` included; empty when it declares none. */
function typesOf(schema: Json, depth = 0): Set<string> {
  const out = new Set<string>()
  if (depth > 4) return out
  const t = schema.type
  if (typeof t === 'string') out.add(t)
  else if (Array.isArray(t)) for (const x of t) if (typeof x === 'string') out.add(x)
  for (const key of ['anyOf', 'oneOf'] as const) {
    const variants = schema[key]
    if (!Array.isArray(variants)) continue
    for (const v of variants) {
      if (isRecord(v)) for (const x of typesOf(v, depth + 1)) out.add(x)
    }
  }
  return out
}

/** The declared `properties` of an object schema, merged over its `anyOf`/`oneOf` variants. */
function propertiesOf(schema: Json, depth = 0): Json {
  const out: Json = {}
  if (depth > 4) return out
  for (const key of ['anyOf', 'oneOf'] as const) {
    const variants = schema[key]
    if (Array.isArray(variants)) {
      for (const v of variants) if (isRecord(v)) Object.assign(out, propertiesOf(v, depth + 1))
    }
  }
  if (isRecord(schema.properties)) Object.assign(out, schema.properties)
  return out
}

function repairObject(
  value: Json,
  schema: Json,
  path: string,
  depth: number,
  repaired: string[],
): Json {
  const properties = propertiesOf(schema)
  let out = value
  for (const [key, sub] of Object.entries(properties)) {
    if (!isRecord(sub) || !Object.hasOwn(value, key)) continue
    const next = repairValue(value[key], sub, path === '' ? key : `${path}.${key}`, depth, repaired)
    if (next !== value[key]) {
      if (out === value) out = { ...value }
      out[key] = next
    }
  }
  return out
}

const CLEAN_NUMBER = /^-?\d+(\.\d+)?$/

/** Repair one primitive against the declared types; `undefined` when the value stays as sent. */
function repairPrimitive(value: unknown, schema: Json, types: Set<string>): unknown {
  if (typeof value === 'number' || typeof value === 'boolean') {
    const allowed = typeof value === 'number' ? ['number', 'integer'] : ['boolean']
    if (!types.has('string') || allowed.some((t) => types.has(t))) return undefined
    if (typeof value === 'number' && !Number.isFinite(value)) return undefined
    const text = String(value)
    // a too-long string is left to the model: the schema's limit is the server's to explain
    if (typeof schema.maxLength === 'number' && text.length > schema.maxLength) return undefined
    return text
  }
  if (typeof value === 'string') {
    const wantsInteger = types.has('integer')
    if (types.has('string') || !(types.has('number') || wantsInteger)) return undefined
    if (!CLEAN_NUMBER.test(value)) return undefined
    const n = Number(value)
    if (!Number.isFinite(n) || (!types.has('number') && !Number.isInteger(n))) return undefined
    return n
  }
  return undefined
}

function repairValue(
  value: unknown,
  schema: Json,
  path: string,
  depth: number,
  repaired: string[],
): unknown {
  const types = typesOf(schema)
  let current = value
  const note = (): void => {
    if (!repaired.includes(path)) repaired.push(path)
  }
  const primitive = repairPrimitive(value, schema, types)
  if (primitive !== undefined) {
    note()
    return primitive
  }
  if (typeof value === 'string' && !types.has('string')) {
    const wantsObject = types.has('object')
    const wantsArray = types.has('array')
    if (wantsObject || wantsArray) {
      const trimmed = value.trim()
      const open = trimmed[0]
      if ((wantsObject && open === '{') || (wantsArray && open === '[')) {
        try {
          const parsed: unknown = JSON.parse(trimmed)
          if ((wantsArray && Array.isArray(parsed)) || (wantsObject && isRecord(parsed))) {
            current = parsed
            note()
          }
        } catch {
          // invalid JSON stays as the model sent it: the server's error is readable
        }
      }
    }
  }
  if (Array.isArray(current) && types.has('array') && isRecord(schema.items)) {
    const items = schema.items
    let out: unknown[] = current
    for (const [i, item] of current.entries()) {
      const next = repairValue(item, items, path, depth, repaired)
      if (next !== item) {
        if (out === current) out = [...current]
        out[i] = next
      }
    }
    return out
  }
  if (isRecord(current) && depth < MAX_DEPTH && types.has('object')) {
    return repairObject(current, schema, path, depth + 1, repaired)
  }
  return current
}

/** Repair `input` against a JSON Schema; returns the input (same reference when unchanged) and the repaired paths. */
export function repairToolInput(
  input: unknown,
  schema: Json,
): { input: unknown; repaired: string[] } {
  if (!isRecord(input)) return { input, repaired: [] }
  const repaired: string[] = []
  const out = repairObject(input, schema, '', 0, repaired)
  return { input: out, repaired }
}

const schemaCache = new WeakMap<object, Promise<Json | undefined>>()

/** The JSON Schema of a tool's input (cached per tool); `undefined` when it cannot be read. */
export function inputJsonSchema(tool: Tool): Promise<Json | undefined> {
  const schema = tool.inputSchema as object | undefined
  if (schema === undefined) return Promise.resolve(undefined)
  let cached = schemaCache.get(schema)
  if (cached === undefined) {
    cached = (async () => {
      try {
        const json: unknown = await asSchema(tool.inputSchema as Parameters<typeof asSchema>[0])
          .jsonSchema
        return isRecord(json) ? json : undefined
      } catch {
        return undefined
      }
    })()
    schemaCache.set(schema, cached)
  }
  return cached
}

/**
 * Repair the raw JSON input of a tool call that failed validation; `undefined` when it is not
 * valid JSON or nothing changed (the model then gets the readable error).
 */
export function repairInputText(
  text: string,
  schema: Json,
): { text: string; repaired: string[] } | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const fixed = repairToolInput(parsed, schema)
  if (fixed.input === parsed) return undefined
  return { text: JSON.stringify(fixed.input), repaired: fixed.repaired }
}
