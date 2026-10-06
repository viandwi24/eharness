/**
 * `openApiTools()`: an OpenAPI 3.0 / 3.1 document as a `ToolSource` (one AI SDK tool per selected
 * operation). Outbound HTTP goes only to the app-supplied base URL; auth comes only from the
 * app-supplied `headers()` function.
 *
 * @see docs/specs/17-openapi-plugin.md
 */
import { jsonSchema, type Tool, type ToolSet, tool } from 'ai'
import { defineToolSource, type HarnessContext, type ToolRisk, type ToolSource } from '../index.ts'
import {
  BLOCKED_HEADERS,
  execute,
  normalizeBase,
  type ParamPlan,
  prepareRequest,
} from './request.ts'
import {
  capText,
  deref,
  invalid,
  isObject,
  type Json,
  loadSpec,
  type SchemaLimits,
  summarizeSchema,
} from './spec.ts'

/** Selected tools above this count are deferred with `defer: 'auto'`. */
export const OPENAPI_AUTO_DEFER_THRESHOLD = 20

/** What the filters, `names` and `risk` functions see of one operation. */
export interface OperationInfo {
  /** Lowercase HTTP method. */
  method: string
  /** Path template, e.g. `/pets/{petId}`. */
  path: string
  operationId?: string
  tags: string[]
  summary?: string
  description?: string
  deprecated: boolean
}

/** Selects operations. Specified fields must all match; list fields match any entry. */
export type OperationFilter =
  | {
      /** HTTP methods, case-insensitive. */
      methods?: string[]
      /** Path globs: `*` matches within a segment, `**` across segments. */
      paths?: string[]
      /** Matches when the operation has any of these tags. */
      tags?: string[]
      operationIds?: string[]
    }
  | ((op: OperationInfo) => boolean)

/** Options of {@link openApiTools}. */
export interface OpenApiToolsOptions {
  /** Short name: source id `'openapi:<name>'` and default tool prefix `<name>_`. `^[a-z0-9-]{1,32}$` */
  name: string
  /**
   * The base URL every request goes to (the operation path is appended). A function is resolved per
   * call. Required unless `useSpecServers: true`.
   */
  baseUrl?: string | ((ctx: HarnessContext) => string)
  /** Use `servers[0].url` of the spec when `baseUrl` is not given. Default false (SSRF, spec 17 §4). */
  useSpecServers?: boolean
  /** Per-call request headers (authentication). The model can never set credentials itself. */
  headers?: (ctx: HarnessContext, op: OperationInfo) => HeadersInit | Promise<HeadersInit>
  /** Only these operations (an array matches any entry). Default: all. */
  include?: OperationFilter | OperationFilter[]
  /** Drop these operations (wins over `include`). */
  exclude?: OperationFilter | OperationFilter[]
  /** Tool names: a map from operationId, or a function per operation (before prefixing). */
  names?: Record<string, string> | ((op: OperationInfo) => string)
  /** Tool name prefix. Default `<name>_`; `''` for none. */
  prefix?: string
  /** A trusted risk per operation (`metadata.risk`); `undefined` keeps {@link riskFromMethod}. */
  risk?: (op: OperationInfo) => ToolRisk | undefined
  /** Maximum number of tools after filtering. Default 64. */
  maxTools?: number
  /** Deferred behind `tool_search`: `'auto'` (default) above 20 tools. */
  defer?: boolean | 'auto'
  /** Per-call timeout. Default 30_000. */
  timeoutMs?: number
  /** Characters read from a response before it is cut. Default 50_000. */
  maxResponseChars?: number
  /** Schema summarization limits. */
  schema?: { maxDepth?: number; maxDescriptionChars?: number }
  /** Injectable `fetch` (tests, proxies). Default: global `fetch`. */
  fetch?: typeof fetch
}

/** Default risk of an HTTP method: GET/HEAD/OPTIONS `'read'`, DELETE `'destructive'`, else `'write'`. */
export function riskFromMethod(method: string): ToolRisk {
  const m = method.toLowerCase()
  if (m === 'get' || m === 'head' || m === 'options') return 'read'
  if (m === 'delete') return 'destructive'
  return 'write'
}

const NAME = /^[a-z0-9-]{1,32}$/
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'] as const
const RISKS: ReadonlySet<unknown> = new Set(['read', 'write', 'destructive', 'external'])

interface OpPlan {
  info: OperationInfo
  toolName: string
  description: string
  schema: Json
  params: ParamPlan[]
  hasBody: boolean
  bodyRequired: boolean
}

function globToRegExp(glob: string): RegExp {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i)
    if (c === '*') {
      if (glob.charAt(i + 1) === '*') {
        source += '.*'
        i++
      } else source += '[^/]*'
    } else source += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

function matcher(filter: OperationFilter | OperationFilter[]): (op: OperationInfo) => boolean {
  const filters = Array.isArray(filter) ? filter : [filter]
  const compiled = filters.map((f): ((op: OperationInfo) => boolean) => {
    if (typeof f === 'function') return f
    const methods = f.methods?.map((m) => m.toLowerCase())
    const paths = f.paths?.map(globToRegExp)
    return (op) =>
      (methods === undefined || methods.includes(op.method)) &&
      (paths === undefined || paths.some((r) => r.test(op.path))) &&
      (f.tags === undefined || op.tags.some((t) => f.tags?.includes(t))) &&
      (f.operationIds === undefined ||
        (op.operationId !== undefined && f.operationIds.includes(op.operationId)))
  })
  return (op) => compiled.some((fn) => fn(op))
}

function slug(text: string): string {
  return text
    .replace(/\{([^}]*)\}/g, '$1')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function sanitizeName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
}

function specServer(doc: Json, at: string): string {
  const servers = doc.servers
  const first = Array.isArray(servers) ? servers[0] : undefined
  if (!isObject(first) || typeof first.url !== 'string') {
    invalid(`${at}: \`useSpecServers\` needs \`servers[0].url\` in the spec (or pass \`baseUrl\`).`)
  }
  let url = first.url
  const vars = isObject(first.variables) ? first.variables : {}
  for (const [key, value] of Object.entries(vars)) {
    if (isObject(value) && typeof value.default === 'string') {
      url = url.replaceAll(`{${key}}`, value.default)
    }
  }
  return url
}

/**
 * Turn an OpenAPI 3.0 / 3.1 document (parsed object or JSON string) into a tool source: one AI SDK
 * tool per operation that passes `include` / `exclude`, named after its `operationId`. Input is
 * grouped as `{ path?, query?, headers?, body? }`. Requests go only to `baseUrl`; the spec's
 * `servers` are ignored unless `useSpecServers: true`. Credentials come from `headers()` only.
 * Tool risk comes from the HTTP method (`riskFromMethod`) unless `risk` overrides it. Results are
 * the parsed JSON (or text); every failure is an error string.
 *
 * @example
 * ```ts
 * defineHarnessAgent({
 *   model,
 *   tools: [
 *     openApiTools(petstoreJson, {
 *       name: 'pets',
 *       baseUrl: 'https://petstore.example.com/v1',
 *       headers: (ctx) => ({ authorization: `Bearer ${ctx.runtime.petToken}` }),
 *       include: { methods: ['get'], tags: ['pets'] },
 *     }),
 *   ],
 * })
 * ```
 * @see docs/specs/17-openapi-plugin.md
 */
export function openApiTools(spec: object | string, opts: OpenApiToolsOptions): ToolSource {
  if (typeof opts !== 'object' || opts === null) invalid('openApiTools: options are required.')
  if (typeof opts.name !== 'string' || !NAME.test(opts.name)) {
    invalid(`openApiTools: \`name\` must match ${NAME} (got '${String(opts.name)}').`)
  }
  const at = `openApiTools('${opts.name}')`
  const doc = loadSpec(spec, at)
  const id = `openapi:${opts.name}`
  const prefix = opts.prefix ?? `${opts.name}_`
  const maxTools = opts.maxTools ?? 64
  const defer = opts.defer ?? 'auto'
  const timeoutMs = opts.timeoutMs ?? 30_000
  const maxResponseChars = opts.maxResponseChars ?? 50_000
  const limits: SchemaLimits = {
    maxDepth: opts.schema?.maxDepth ?? 6,
    maxDescriptionChars: opts.schema?.maxDescriptionChars ?? 300,
  }
  if (!Number.isInteger(maxTools) || maxTools < 1)
    invalid(`${at}: \`maxTools\` must be a positive integer.`)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    invalid(`${at}: \`timeoutMs\` must be positive.`)
  if (!Number.isInteger(maxResponseChars) || maxResponseChars < 1) {
    invalid(`${at}: \`maxResponseChars\` must be a positive integer.`)
  }
  if (defer !== true && defer !== false && defer !== 'auto') {
    invalid(`${at}: \`defer\` must be true, false or 'auto'.`)
  }
  if (opts.prefix !== undefined && typeof opts.prefix !== 'string') {
    invalid(`${at}: \`prefix\` must be a string.`)
  }

  // base URL: app-supplied; the spec's servers only with useSpecServers
  let staticBase: string | undefined
  let resolveBase: (ctx: HarnessContext) => string
  if (typeof opts.baseUrl === 'function') {
    resolveBase = opts.baseUrl
  } else {
    const raw = opts.baseUrl ?? (opts.useSpecServers === true ? specServer(doc, at) : undefined)
    if (raw === undefined) {
      invalid(
        `${at}: \`baseUrl\` is required (the spec's \`servers\` are not trusted; pass useSpecServers: true to use them).`,
      )
    }
    staticBase = normalizeBase(raw)
    if (staticBase === undefined) {
      invalid(
        `${at}: \`baseUrl\` must be an absolute http(s) URL without credentials (got '${raw}').`,
      )
    }
    const fixed = staticBase
    resolveBase = () => fixed
  }

  const included = opts.include === undefined ? undefined : matcher(opts.include)
  const excluded = opts.exclude === undefined ? undefined : matcher(opts.exclude)

  // API-key schemes in headers: never settable by the model
  const blockedHeaders = new Set(BLOCKED_HEADERS)
  const schemes =
    isObject(doc.components) && isObject(doc.components.securitySchemes)
      ? doc.components.securitySchemes
      : {}
  for (const scheme of Object.values(schemes)) {
    const s = deref(doc, scheme, at)
    if (isObject(s) && s.type === 'apiKey' && s.in === 'header' && typeof s.name === 'string') {
      blockedHeaders.add(s.name.toLowerCase())
    }
  }

  const skipped: string[] = []
  const plans: OpPlan[] = []
  for (const [path, rawItem] of Object.entries(doc.paths as Json)) {
    const item = deref(doc, rawItem, at)
    if (!isObject(item)) continue
    for (const method of METHODS) {
      const rawOp = item[method]
      if (!isObject(rawOp)) continue
      const op = deref(doc, rawOp, at)
      const info: OperationInfo = {
        method,
        path,
        ...(typeof op.operationId === 'string' ? { operationId: op.operationId } : {}),
        tags: Array.isArray(op.tags)
          ? op.tags.filter((t): t is string => typeof t === 'string')
          : [],
        ...(typeof op.summary === 'string' ? { summary: op.summary } : {}),
        ...(typeof op.description === 'string' ? { description: op.description } : {}),
        deprecated: op.deprecated === true,
      }
      if (included !== undefined && !included(info)) continue
      if (excluded?.(info) === true) continue
      const plan = planOperation(doc, item, op, info)
      if (plan !== undefined) plans.push(plan)
    }
  }

  function planOperation(
    root: Json,
    item: Json,
    op: Json,
    info: OperationInfo,
  ): OpPlan | undefined {
    const label = `${info.method.toUpperCase()} ${info.path}`
    // path-item parameters, overridden by operation parameters (same name + in)
    const merged = new Map<string, Json>()
    for (const list of [item.parameters, op.parameters]) {
      if (!Array.isArray(list)) continue
      for (const raw of list) {
        const p = deref(root, raw, at)
        if (isObject(p) && typeof p.name === 'string' && typeof p.in === 'string') {
          merged.set(`${p.in}:${p.name}`, p)
        }
      }
    }
    const groups: Record<'path' | 'query' | 'header', { props: Json; required: string[] }> = {
      path: { props: {}, required: [] },
      query: { props: {}, required: [] },
      header: { props: {}, required: [] },
    }
    const params: ParamPlan[] = []
    for (const p of merged.values()) {
      const where = p.in as string
      if (where !== 'path' && where !== 'query' && where !== 'header') {
        skipped.push(`${label}: ${where} parameter '${String(p.name)}' is not supported`)
        continue
      }
      const name = p.name as string
      if (where === 'header' && blockedHeaders.has(name.toLowerCase())) continue // app-supplied
      const content = isObject(p.content) ? Object.values(p.content)[0] : undefined
      const rawSchema = p.schema ?? (isObject(content) ? content.schema : undefined)
      const schema = summarizeSchema(root, rawSchema, limits, `${at} ${label}`, { request: true })
      const description = capText(p.description, limits.maxDescriptionChars)
      if (schema.description === undefined && description !== undefined)
        schema.description = description
      const required = where === 'path' || p.required === true
      groups[where].props[name] = schema
      if (required) groups[where].required.push(name)
      const style = typeof p.style === 'string' ? p.style : where === 'query' ? 'form' : 'simple'
      params.push({
        name,
        in: where,
        required,
        style,
        explode: typeof p.explode === 'boolean' ? p.explode : style === 'form',
      })
    }
    const properties: Json = {}
    const required: string[] = []
    const keys = { path: 'path', query: 'query', header: 'headers' } as const
    for (const where of ['path', 'query', 'header'] as const) {
      const g = groups[where]
      if (Object.keys(g.props).length === 0) continue
      properties[keys[where]] = {
        type: 'object',
        properties: g.props,
        ...(g.required.length > 0 ? { required: g.required } : {}),
        additionalProperties: false,
      }
      if (g.required.length > 0) required.push(keys[where])
    }
    let hasBody = false
    let bodyRequired = false
    const rawBody = op.requestBody
    if (rawBody !== undefined) {
      const body = deref(root, rawBody, at)
      const content = isObject(body) && isObject(body.content) ? body.content : {}
      const key = Object.keys(content).find((t) => /^application\/(.+\+)?json/i.test(t))
      const media = key === undefined ? undefined : content[key]
      if (!isObject(media)) {
        skipped.push(`${label}: the request body is not JSON`)
        // keep the operation without a body only when the body is optional
        if (isObject(body) && body.required === true) {
          return undefined
        }
      } else {
        hasBody = true
        bodyRequired = isObject(body) && body.required === true
        const schema = summarizeSchema(root, media.schema, limits, `${at} ${label}`, {
          request: true,
        })
        const description = isObject(body)
          ? capText(body.description, limits.maxDescriptionChars)
          : undefined
        if (schema.description === undefined && description !== undefined)
          schema.description = description
        properties.body = schema
        if (bodyRequired) required.push('body')
      }
    }
    const summary = capText(op.summary, limits.maxDescriptionChars)
    const detail = capText(op.description, limits.maxDescriptionChars)
    const description = [`${label}`, summary, detail !== summary ? detail : undefined]
      .filter((x): x is string => x !== undefined)
      .join('\n')
    return {
      info,
      toolName: '',
      description,
      schema: {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false,
      },
      params,
      hasBody,
      bodyRequired,
    }
  }

  const usable = plans
  if (usable.length > maxTools) {
    invalid(
      `${at}: ${usable.length} operations selected, more than maxTools (${maxTools}). Narrow the selection with \`include\` / \`exclude\` (methods, paths, tags, operationIds) or raise \`maxTools\`.`,
    )
  }

  // names
  const used = new Map<string, string>()
  for (const plan of usable) {
    const info = plan.info
    const label = `${info.method.toUpperCase()} ${info.path}`
    let base: string | undefined
    if (typeof opts.names === 'function') base = opts.names(info)
    else if (info.operationId !== undefined) base = opts.names?.[info.operationId]
    base ??= info.operationId ?? `${info.method}_${slug(info.path)}`
    let name = `${prefix}${sanitizeName(base)}`
    if (name.length > 64) name = name.slice(0, 64)
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
      invalid(`${at}: cannot derive a valid tool name for ${label} (got '${name}'); use \`names\`.`)
    }
    const clash = used.get(name)
    if (clash !== undefined) {
      invalid(`${at}: duplicate tool name '${name}' for ${label} and ${clash}; use \`names\`.`)
    }
    used.set(name, label)
    plan.toolName = name
  }

  const deferred = defer === 'auto' ? usable.length > OPENAPI_AUTO_DEFER_THRESHOLD : defer

  function riskOf(ctx: HarnessContext, info: OperationInfo): ToolRisk {
    if (opts.risk !== undefined) {
      try {
        const risk = opts.risk(info)
        if (risk !== undefined && RISKS.has(risk)) return risk
        if (risk !== undefined) {
          ctx.log.warn(
            `eharness: ${id} risk function returned an invalid risk; using the method default`,
            { risk },
          )
        }
      } catch (error) {
        ctx.log.warn(`eharness: ${id} risk function failed; using the method default`, { error })
      }
    }
    return riskFromMethod(info.method)
  }

  let warnedSkipped = false
  return defineToolSource({
    id,
    list(ctx): ToolSet {
      if (!warnedSkipped && skipped.length > 0) {
        warnedSkipped = true
        for (const message of skipped) ctx.log.warn(`eharness: ${id} skipped: ${message}`)
      }
      const out: ToolSet = {}
      for (const plan of usable) {
        const info = plan.info
        const t = tool({
          description: plan.description,
          inputSchema: jsonSchema(plan.schema as never),
          metadata: {
            risk: riskOf(ctx, info),
            openapi: {
              method: info.method,
              path: info.path,
              ...(info.operationId === undefined ? {} : { operationId: info.operationId }),
            },
          },
          execute: async (input: unknown, options: { abortSignal?: AbortSignal }) => {
            let base: string | undefined
            try {
              const raw = resolveBase(ctx)
              base = typeof raw === 'string' ? normalizeBase(raw) : undefined
            } catch (error) {
              return `Request failed: baseUrl could not be resolved (${error instanceof Error ? error.message : String(error)}).`
            }
            if (base === undefined) return 'Request failed: baseUrl is not a valid http(s) URL.'
            const prepared = prepareRequest({
              base,
              pathTemplate: info.path,
              params: plan.params,
              hasBody: plan.hasBody,
              bodyRequired: plan.bodyRequired,
              input,
              blockedHeaders,
            })
            if (!prepared.ok) return prepared.error
            const headers: Record<string, string> = {
              accept: 'application/json, text/plain;q=0.9, */*;q=0.1',
              ...prepared.headers,
            }
            if (opts.headers !== undefined) {
              try {
                const extra = new Headers(await opts.headers(ctx, info))
                // app headers win over model-supplied ones (case-insensitive)
                extra.forEach((value, key) => {
                  for (const existing of Object.keys(headers)) {
                    if (existing.toLowerCase() === key) delete headers[existing]
                  }
                  headers[key] = value
                })
              } catch (error) {
                return `Request failed: could not build the request headers (${error instanceof Error ? error.message : String(error)}).`
              }
            }
            return await execute({
              fetch: opts.fetch ?? (((input, init) => fetch(input, init)) as typeof fetch),
              method: info.method,
              url: prepared.url,
              base,
              headers,
              body: prepared.body,
              timeoutMs,
              maxResponseChars,
              signals: [ctx.signal, options?.abortSignal],
            })
          },
        }) as Tool
        out[plan.toolName] = deferred ? ({ ...t, deferLoading: true } as Tool) : t
      }
      return out
    },
  })
}
