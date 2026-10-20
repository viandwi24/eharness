/**
 * Conservative input repair for tools whose input schema is a JSON Schema (MCP and other
 * `jsonSchema()` tools, which the AI SDK does not validate): a model that sends an `object` or
 * `array` property as a JSON-encoded string gets it parsed before `execute`.
 *
 * Only a string that parses to exactly the declared type is replaced; strings where the schema
 * also allows `string`, untyped properties and invalid JSON are never touched.
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

function repairValue(
  value: unknown,
  schema: Json,
  path: string,
  depth: number,
  repaired: string[],
): unknown {
  const types = typesOf(schema)
  let current = value
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
            repaired.push(path)
          }
        } catch {
          // invalid JSON stays as the model sent it: the server's error is readable
        }
      }
    }
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
