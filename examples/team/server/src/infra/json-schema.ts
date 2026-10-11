/**
 * JSON Schema validation for deliverables (phase H): zod 4's `z.fromJSONSchema`. The supported
 * subset is whatever zod converts (type, properties, required, items, enum, const, min/max,
 * pattern, additionalProperties, anyOf/oneOf/allOf, local `$ref`); keywords it does not know are
 * ignored (a `required` key without a `properties` entry is handled). Installed into the pure domain once at composition (`main.ts`).
 */
import { z } from 'zod'
import { installSchemaValidator, type SchemaValidator } from '../domain/deliverables.ts'

/**
 * zod ignores a `required` key that has no entry in `properties`; JSON Schema does not. Give every
 * such key an empty schema (anything), at every depth, so the key is required as written.
 */
function withRequiredKeys(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withRequiredKeys)
  if (typeof node !== 'object' || node === null) return node
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) out[key] = withRequiredKeys(value)
  if (Array.isArray(out.required)) {
    const props = { ...((out.properties as Record<string, unknown> | undefined) ?? {}) }
    for (const name of out.required)
      if (typeof name === 'string' && !(name in props)) props[name] = {}
    out.properties = props
  }
  return out
}

const compiled = (schema: Record<string, unknown>): z.ZodType | string => {
  try {
    return z.fromJSONSchema(withRequiredKeys(schema) as never) as z.ZodType
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const where = (path: ReadonlyArray<PropertyKey>): string =>
  path.length === 0 ? '(root)' : path.map(String).join('.')

export const zodSchemaValidator: SchemaValidator = {
  compile(schema) {
    const c = compiled(schema)
    return typeof c === 'string' ? c : undefined
  },
  validate(schema, value) {
    const c = compiled(schema)
    if (typeof c === 'string') return [`the schema cannot be used: ${c}`]
    const parsed = c.safeParse(value)
    return parsed.success
      ? []
      : parsed.error.issues.map(
          (i) => `does not match the schema at ${where(i.path)}: ${i.message}`,
        )
  },
}

export const installJsonSchemaValidator = (): void => installSchemaValidator(zodSchemaValidator)
