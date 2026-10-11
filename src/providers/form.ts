/**
 * Form description derived from a provider's zod settings, plus secret redaction and the
 * edit-without-resending-secrets merge.
 *
 * @see docs/specs/23-providers.md#2-forms-redaction-and-secrets
 */
import { toJSONSchema, type z } from 'zod/v4'
import { HarnessError } from '../index.ts'
import type {
  ConfigProfile,
  FieldGroup,
  FieldMeta,
  FieldWidget,
  FormField,
  ProviderFormSpec,
  PublicConfigProfile,
  SecretStatus,
} from './types.ts'

/**
 * Typed helper for the `'x-eh'` metadata key.
 *
 * @example
 * ```ts
 * z.string().meta({ title: 'API key', ...ehMeta({ secret: true, group: 'auth' }) })
 * ```
 */
export function ehMeta(meta: FieldMeta): { 'x-eh': FieldMeta } {
  return { 'x-eh': meta }
}

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Words of a camelCase / snake_case key as a label (`baseURL` → `Base URL`). */
function humanize(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** Collapse `anyOf` / `oneOf` of a nullable or optional value into one schema node. */
function normalize(node: Json): Json {
  const variants = (node.anyOf ?? node.oneOf) as unknown
  if (!Array.isArray(variants)) return node
  const rest = (variants as Json[]).filter((v) => !(isObject(v) && v.type === 'null'))
  const { anyOf: _a, oneOf: _o, ...outer } = node
  if (rest.length === 1 && isObject(rest[0])) return { ...normalize(rest[0]), ...outer }
  if (rest.length > 1 && rest.every((v) => isObject(v) && 'const' in v)) {
    return { ...outer, enum: rest.map((v) => v.const) }
  }
  return { ...outer, type: 'json' }
}

function toField(path: string, key: string, raw: Json, required: boolean): FormField {
  const node = normalize(raw)
  const meta = isObject(node['x-eh']) ? (node['x-eh'] as FieldMeta) : {}
  const secret = meta.secret === true
  const secretValues = meta.secretValues === true
  let kind: FormField['kind'] = 'json'
  if (Array.isArray(node.enum)) kind = 'enum'
  else if (node.type === 'string') kind = 'string'
  else if (node.type === 'number') kind = 'number'
  else if (node.type === 'integer') kind = 'integer'
  else if (node.type === 'boolean') kind = 'boolean'
  else if (node.type === 'array') kind = 'array'
  else if (node.type === 'object') kind = 'record'
  let widget: FieldWidget | undefined = meta.widget
  if (widget === undefined) {
    if (secret) widget = 'password'
    else if (kind === 'record') widget = 'keyvalue'
    else if (kind === 'enum') widget = 'select'
  }
  const group: FieldGroup = meta.group ?? (secret ? 'auth' : 'endpoint')
  const field: FormField = {
    path,
    kind,
    label: typeof node.title === 'string' ? node.title : humanize(key),
    required,
    secret,
    secretValues,
    group,
  }
  if (widget !== undefined) field.widget = widget
  if (typeof node.description === 'string') field.description = node.description
  if (kind === 'enum') {
    field.options = (node.enum as Array<string | number | boolean>).map((value) => ({
      value,
      label: meta.optionLabels?.[String(value)] ?? String(value),
    }))
  }
  if ('default' in node) field.default = node.default
  if (meta.showWhen !== undefined) field.showWhen = meta.showWhen
  if (meta.placeholder !== undefined) field.placeholder = meta.placeholder
  if (meta.envHint !== undefined) field.envHint = meta.envHint
  if (typeof node.format === 'string') field.format = node.format
  if (meta.endpoint ?? (node.format === 'uri' || node.format === 'url')) field.endpoint = true
  if (typeof node.minimum === 'number' && kind !== 'integer') field.min = node.minimum
  if (typeof node.maximum === 'number' && kind !== 'integer') field.max = node.maximum
  return field
}

function collect(schema: Json, prefix: string, parentRequired: boolean, out: FormField[]): void {
  const props = schema.properties
  if (!isObject(props)) return
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : []
  for (const [key, value] of Object.entries(props)) {
    if (!isObject(value)) continue
    const node = normalize(value)
    const path = prefix === '' ? key : `${prefix}.${key}`
    const isRequired = parentRequired && required.includes(key)
    if (node.type === 'object' && isObject(node.properties)) {
      collect(node, path, isRequired, out)
    } else {
      out.push(toField(path, key, value, isRequired))
    }
  }
}

/**
 * Describe a zod settings object as a flat, framework-neutral field list (plus the JSON
 * Schema of the input shape). Field order is the schema's property order; nested objects become
 * dotted paths; `keyvalue` fields are `record` kinds. Without `x-eh.group`, secrets are in
 * `auth` and everything else in `endpoint`.
 *
 * @example
 * ```ts
 * const { fields } = formSpec(z.object({ token: z.string().meta(ehMeta({ secret: true })) }))
 * ```
 */
export function formSpec(schema: z.ZodObject): ProviderFormSpec {
  const jsonSchema = toJSONSchema(schema, { io: 'input' }) as Json
  const fields: FormField[] = []
  collect(jsonSchema, '', true, fields)
  return { fields, jsonSchema }
}

/** {@link formSpec} of a provider definition (generic machinery: any zod object works). */
export function providerFormSpec(definition: { settings: z.ZodObject }): ProviderFormSpec {
  return formSpec(definition.settings)
}

function getPath(root: unknown, path: string): unknown {
  let cur: unknown = root
  for (const part of path.split('.')) {
    if (!isObject(cur)) return undefined
    cur = cur[part]
  }
  return cur
}

function hasPath(root: unknown, path: string): boolean {
  let cur: unknown = root
  for (const part of path.split('.')) {
    if (!isObject(cur) || !Object.hasOwn(cur, part)) return false
    cur = cur[part]
  }
  return true
}

function setPath(root: Json, path: string, value: unknown): void {
  const parts = path.split('.')
  let cur = root
  for (const part of parts.slice(0, -1)) {
    const next = cur[part]
    if (isObject(next)) cur = next
    else {
      const created: Json = {}
      cur[part] = created
      cur = created
    }
  }
  const last = parts[parts.length - 1] as string
  cur[last] = value
}

function deletePath(root: Json, path: string): void {
  const parts = path.split('.')
  let cur: unknown = root
  for (const part of parts.slice(0, -1)) {
    if (!isObject(cur)) return
    cur = cur[part]
  }
  const last = parts[parts.length - 1] as string
  if (isObject(cur)) delete cur[last]
}

/** `true` for the patch value that keeps a stored secret: `{ keep: true }`. */
function isKeep(value: unknown): boolean {
  return isObject(value) && value.keep === true
}

/** A secret as {@link SecretStatus}: set or not, plus the last 4 characters of long values. */
export function secretStatus(value: unknown, hint = true): SecretStatus {
  if (typeof value !== 'string' || value === '') return { set: false }
  return hint && value.length >= 12 ? { set: true, hint: `…${value.slice(-4)}` } : { set: true }
}

/** Options of {@link redactProfile}. */
export interface RedactOptions {
  /** Include the last 4 characters of long secrets. Default `true`. */
  hint?: boolean
}

/**
 * Settings as sent to a browser. Only fields the schema knows are copied (unknown keys are
 * dropped); every secret becomes `{ set, hint? }`, and a `secretValues` record maps each key to
 * one. The result holds no secret, so it can be serialized or logged.
 */
export function redactSettings(
  schema: z.ZodObject,
  settings: Record<string, unknown>,
  options: RedactOptions = {},
): Record<string, unknown> {
  const hint = options.hint !== false
  const out: Json = {}
  for (const field of formSpec(schema).fields) {
    const value = getPath(settings, field.path)
    if (field.secret) {
      setPath(out, field.path, secretStatus(value, hint))
    } else if (field.secretValues) {
      if (isObject(value)) {
        const redacted: Record<string, SecretStatus> = {}
        for (const [k, v] of Object.entries(value)) redacted[k] = secretStatus(v, hint)
        setPath(out, field.path, redacted)
      }
    } else if (value !== undefined) {
      setPath(out, field.path, structuredClone(value))
    }
  }
  return out
}

/** {@link redactSettings} applied to a profile of any kind (other fields are deep-copied). */
export function redactProfile<P extends ConfigProfile>(
  schema: z.ZodObject,
  profile: P,
  options: RedactOptions = {},
): PublicConfigProfile<P> {
  const { settings, ...rest } = profile
  return {
    ...structuredClone(rest),
    settings: redactSettings(schema, settings as Record<string, unknown>, options),
  } as PublicConfigProfile<P>
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * `true` when `patch` changes an endpoint field (a `format: 'uri'` field or `endpoint: true`
 * meta) of `stored`: a different value, or `null` on a stored one. A field absent from the patch
 * or equal to the stored value is not a change. A secret kept across such a change would be sent
 * to the new endpoint, so {@link mergeSecretPatch} drops the stored secrets then.
 */
export function endpointChanged(
  schema: z.ZodObject,
  stored: Record<string, unknown>,
  patch: Record<string, unknown>,
): boolean {
  for (const field of formSpec(schema).fields) {
    if (field.endpoint !== true || !hasPath(patch, field.path)) continue
    const value = getPath(patch, field.path)
    if (value === undefined) continue
    const before = getPath(stored, field.path)
    if (value === null ? before !== undefined && before !== null : !sameValue(before, value))
      return true
  }
  return false
}

/**
 * Apply an edit from a form to stored settings without the form resending secrets. A field absent
 * from `patch` keeps its stored value; a secret given as `undefined`, `''` or `{ keep: true }`
 * keeps it; `null` removes any field; a `secretValues` record keeps a stored value for a key
 * given as `''` / `{ keep: true }` and drops keys that are missing from the patch. Keys the
 * schema does not know are ignored.
 *
 * When the patch changes an endpoint field ({@link endpointChanged}) no stored secret is kept:
 * every secret and `secretValues` entry must be resent in the same patch, otherwise it is cleared
 * (and `validateSettings` reports a required one as missing). This stops an edit from pointing a
 * profile at another host that then receives the old key. Returns a new object; validation is
 * separate ({@link validateSettings}).
 */
export function mergeSecretPatch(
  schema: z.ZodObject,
  stored: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const fields = formSpec(schema).fields
  const rebind = endpointChanged(schema, stored, patch)
  const base = structuredClone(stored)
  if (rebind) {
    for (const field of fields) {
      if (field.secret) deletePath(base, field.path)
      else if (field.secretValues) deletePath(base, field.path)
    }
  }
  const out = structuredClone(base)
  for (const field of fields) {
    if (!hasPath(patch, field.path)) continue
    const value = getPath(patch, field.path)
    if (value === null) {
      deletePath(out, field.path)
    } else if (field.secret) {
      if (value === undefined || value === '' || isKeep(value)) continue
      setPath(out, field.path, value)
    } else if (field.secretValues && isObject(value)) {
      const before = getPath(base, field.path)
      const next: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value)) {
        if (v === '' || isKeep(v) || v === undefined) {
          if (isObject(before) && typeof before[k] === 'string') next[k] = before[k]
        } else next[k] = v
      }
      setPath(out, field.path, next)
    } else if (value !== undefined) {
      setPath(out, field.path, structuredClone(value))
    }
  }
  return out
}

/** Every secret string of settings (for scrubbing messages). */
export function secretValuesOf(schema: z.ZodObject, settings: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const field of formSpec(schema).fields) {
    const value = getPath(settings, field.path)
    if (field.secret && typeof value === 'string' && value !== '') out.push(value)
    else if (field.secretValues && isObject(value)) {
      for (const v of Object.values(value)) if (typeof v === 'string' && v !== '') out.push(v)
    }
  }
  return out
}

/**
 * Parse settings with a schema (defaults applied). Throws `EH_CONFIG_INVALID`
 * (`details.reason: 'settings-invalid'`) listing `path: message` of every issue; no value is
 * ever included.
 */
export function validateSettings(
  schema: z.ZodObject,
  settings: Record<string, unknown>,
  name = 'settings',
): Record<string, unknown> {
  const parsed = schema.safeParse(settings)
  if (parsed.success) return parsed.data as Record<string, unknown>
  const issues = parsed.error.issues.map((issue) => {
    const path = issue.path.join('.')
    return path === '' ? issue.message : `${path}: ${issue.message}`
  })
  throw new HarnessError('EH_CONFIG_INVALID', `Invalid ${name}: ${issues.join('; ')}`, {
    details: { reason: 'settings-invalid', issues },
  })
}

/** Replace every secret in `text` with `***` (error messages, logs). */
export function scrub(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join('***')
  }
  return out.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 ***')
}
