/**
 * Request building and execution for `eharness/openapi`: path / query serialization, the
 * base-URL fence, same-origin redirects, timeout, and result mapping into strings the model can
 * read (never throws for expected failures).
 *
 * @see docs/specs/17-openapi-plugin.md
 */

/** One declared parameter of an operation. */
export interface ParamPlan {
  name: string
  in: 'path' | 'query' | 'header'
  required: boolean
  style: string
  explode: boolean
}

/** Header names the model can never set (credentials and transport framing). */
export const BLOCKED_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
])

function scalar(value: unknown): string {
  if (typeof value === 'object' && value !== null) return JSON.stringify(value)
  return String(value)
}

const enc = encodeURIComponent

/** `style: simple` (path and header parameters). */
export function serializeSimple(value: unknown, explode: boolean): string {
  if (Array.isArray(value)) return value.map(scalar).join(',')
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value)
      .map(([k, v]) => (explode ? `${k}=${scalar(v)}` : `${k},${scalar(v)}`))
      .join(',')
  }
  return scalar(value)
}

/** Query parts (`name=value`, already percent-encoded) of one query parameter. */
export function serializeQuery(param: ParamPlan, value: unknown): string[] {
  const name = param.name
  if (Array.isArray(value)) {
    if (param.style === 'form' && param.explode)
      return value.map((v) => `${enc(name)}=${enc(scalar(v))}`)
    const sep = param.style === 'spaceDelimited' ? ' ' : param.style === 'pipeDelimited' ? '|' : ','
    return [`${enc(name)}=${value.map((v) => enc(scalar(v))).join(enc(sep))}`]
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
    if (param.style === 'deepObject') {
      return entries.map(([k, v]) => `${enc(`${name}[${k}]`)}=${enc(scalar(v))}`)
    }
    if (param.explode) return entries.map(([k, v]) => `${enc(k)}=${enc(scalar(v))}`)
    return [`${enc(name)}=${entries.flatMap(([k, v]) => [enc(k), enc(scalar(v))]).join(',')}`]
  }
  return [`${enc(name)}=${enc(scalar(value))}`]
}

/** What the model supplied for one call. */
export interface CallInput {
  path?: Record<string, unknown>
  query?: Record<string, unknown>
  headers?: Record<string, unknown>
  body?: unknown
}

/** A prepared request, or a rejection text for the model. */
export type Prepared =
  | { ok: true; url: string; headers: Record<string, string>; body: string | undefined }
  | { ok: false; error: string }

export interface PrepareArgs {
  base: string
  pathTemplate: string
  params: readonly ParamPlan[]
  hasBody: boolean
  bodyRequired: boolean
  input: unknown
  /** Header names (lowercase) the model may not set: blocked set plus the API-key schemes. */
  blockedHeaders: ReadonlySet<string>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Normalize the base URL (no trailing slash); `undefined` unless http(s). */
export function normalizeBase(raw: string): string | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  if (url.username !== '' || url.password !== '') return undefined
  url.hash = ''
  url.search = ''
  return url.href.replace(/\/+$/, '')
}

/** True when `target` stays under `base` (same origin and path prefix). */
export function withinBase(base: string, target: string): boolean {
  let b: URL
  let t: URL
  try {
    b = new URL(base)
    t = new URL(target)
  } catch {
    return false
  }
  if (b.origin !== t.origin) return false
  const prefix = b.pathname.replace(/\/+$/, '')
  return t.pathname === prefix || t.pathname.startsWith(`${prefix}/`) || prefix === ''
}

/**
 * A path parameter value that could climb out of its segment: a `.` or `..` segment (split on `/`
 * and `\`, raw or percent-decoded, also repeatedly) or an encoded `/` or `\` (`%2f`, `%5c`).
 */
export function unsafePathValue(text: string): boolean {
  let current = text
  for (let round = 0; round < 3; round++) {
    if (/%2f|%5c/i.test(current)) return true
    if (current.split(/[\\/]/).some((segment) => segment === '.' || segment === '..')) return true
    let decoded: string
    try {
      decoded = decodeURIComponent(current)
    } catch {
      return false
    }
    if (decoded === current) return false
    current = decoded
  }
  return false
}

/** Build the request of one call from the model's input (all failures are rejection texts). */
export function prepareRequest(args: PrepareArgs): Prepared {
  const input = record(args.input) ?? {}
  const sections: Record<'path' | 'query' | 'header', Record<string, unknown>> = {
    path: record(input.path) ?? {},
    query: record(input.query) ?? {},
    header: record(input.headers) ?? {},
  }
  const declared = (where: 'path' | 'query' | 'header'): Set<string> =>
    new Set(args.params.filter((p) => p.in === where).map((p) => p.name))
  for (const where of ['path', 'query', 'header'] as const) {
    const names = declared(where)
    for (const key of Object.keys(sections[where])) {
      if (where === 'header') {
        const lower = key.toLowerCase()
        if (args.blockedHeaders.has(lower)) {
          return { ok: false, error: `REJECTED: header '${key}' cannot be set by the model.` }
        }
        if (![...names].some((n) => n.toLowerCase() === lower)) {
          return { ok: false, error: `REJECTED: unknown header parameter '${key}'.` }
        }
      } else if (!names.has(key)) {
        return { ok: false, error: `REJECTED: unknown ${where} parameter '${key}'.` }
      }
    }
  }
  for (const p of args.params) {
    if (!p.required) continue
    const given = sections[p.in][p.name]
    if (given === undefined || given === null) {
      return { ok: false, error: `INVALID: missing required ${p.in} parameter '${p.name}'.` }
    }
  }
  if (args.hasBody && args.bodyRequired && input.body === undefined) {
    return { ok: false, error: "INVALID: missing required 'body'." }
  }
  if (!args.hasBody && input.body !== undefined) {
    return { ok: false, error: "REJECTED: this operation takes no 'body'." }
  }

  let path = args.pathTemplate
  for (const p of args.params.filter((x) => x.in === 'path')) {
    const raw = sections.path[p.name]
    const text = serializeSimple(raw, p.explode)
    if (text === '' || unsafePathValue(text)) {
      return { ok: false, error: `REJECTED: invalid value for path parameter '${p.name}'.` }
    }
    path = path.replaceAll(`{${p.name}}`, enc(text))
  }
  const unresolved = /\{[^}]+\}/.exec(path)
  if (unresolved !== null) {
    return { ok: false, error: `INVALID: path parameter ${unresolved[0]} has no value.` }
  }

  const parts: string[] = []
  for (const p of args.params.filter((x) => x.in === 'query')) {
    const value = sections.query[p.name]
    if (value === undefined || value === null) continue
    parts.push(...serializeQuery(p, value))
  }
  const url = `${args.base}${path}${parts.length > 0 ? `?${parts.join('&')}` : ''}`
  if (!withinBase(args.base, url)) {
    return { ok: false, error: 'REJECTED: the request would leave the configured base URL.' }
  }

  const headers: Record<string, string> = {}
  for (const p of args.params.filter((x) => x.in === 'header')) {
    const value = sections.header[p.name]
    if (value === undefined || value === null) continue
    headers[p.name] = serializeSimple(value, p.explode)
  }
  let body: string | undefined
  if (args.hasBody && input.body !== undefined) {
    body = JSON.stringify(input.body)
    headers['content-type'] = 'application/json'
  }
  return { ok: true, url, headers, body }
}

/** Options of {@link execute}. */
export interface ExecuteArgs {
  fetch: typeof fetch
  method: string
  url: string
  base: string
  headers: Record<string, string>
  body: string | undefined
  timeoutMs: number
  maxResponseChars: number
  signals: Array<AbortSignal | undefined>
}

const MAX_REDIRECTS = 5

/** Run the request; always resolves (to the parsed value or an error string). */
export async function execute(args: ExecuteArgs): Promise<unknown> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, args.timeoutMs)
  const listeners: Array<() => void> = []
  for (const signal of args.signals) {
    if (signal === undefined) continue
    if (signal.aborted) controller.abort()
    else {
      const onAbort = (): void => controller.abort()
      signal.addEventListener('abort', onAbort, { once: true })
      listeners.push(() => signal.removeEventListener('abort', onAbort))
    }
  }
  try {
    let url = args.url
    let method = args.method.toUpperCase()
    let body = args.body
    let headers = args.headers
    for (let hop = 0; ; hop++) {
      const response = await args.fetch(url, {
        method,
        headers,
        redirect: 'manual',
        signal: controller.signal,
        ...(body === undefined ? {} : { body }),
      })
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        const location = response.headers.get('location') as string
        let next: string
        try {
          next = new URL(location, url).href
        } catch {
          return `HTTP ${response.status} ${response.statusText}: invalid redirect location.`
        }
        await response.body?.cancel().catch(() => undefined)
        if (!withinBase(args.base, next)) {
          return `REDIRECT BLOCKED: HTTP ${response.status} to ${new URL(next).origin}, outside the configured base URL; not followed.`
        }
        if (hop >= MAX_REDIRECTS) return 'REDIRECT BLOCKED: too many redirects.'
        if (
          response.status !== 307 &&
          response.status !== 308 &&
          method !== 'GET' &&
          method !== 'HEAD'
        ) {
          method = 'GET'
          body = undefined
          const { 'content-type': _ct, ...rest } = headers
          headers = rest
        }
        url = next
        continue
      }
      return await mapResponse(response, args.maxResponseChars)
    }
  } catch (error) {
    if (timedOut) return `Request timed out after ${args.timeoutMs} ms.`
    if (controller.signal.aborted) return 'Request aborted.'
    return `Request failed: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    clearTimeout(timer)
    for (const off of listeners) off()
  }
}

/** Read up to `max` characters of the body; `truncated` when more was available. */
async function readLimited(
  response: Response,
  max: number,
): Promise<{ text: string; truncated: boolean }> {
  if (response.body === null) return { text: '', truncated: false }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
    if (text.length > max) {
      await reader.cancel().catch(() => undefined)
      return { text: text.slice(0, max), truncated: true }
    }
  }
  text += decoder.decode()
  return { text, truncated: text.length > max }
}

const TEXT_TYPE =
  /^(text\/|application\/(json|xml|x-www-form-urlencoded|yaml|x-yaml|javascript)|.*\+(json|xml))/i

async function mapResponse(response: Response, max: number): Promise<unknown> {
  const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? ''
  if (!response.ok) {
    const { text } = await readLimited(response, 500)
    const head = text.trim()
    return `HTTP ${response.status} ${response.statusText}${head === '' ? '' : `: ${head}`}`
  }
  if (response.status === 204 || response.status === 205) {
    return `OK: HTTP ${response.status} ${response.statusText}`.trimEnd()
  }
  if (type !== '' && !TEXT_TYPE.test(type)) {
    await response.body?.cancel().catch(() => undefined)
    return `UNSUPPORTED: the response content type '${type}' is binary or unsupported.`
  }
  const { text, truncated } = await readLimited(response, max)
  if (truncated) return `${text}\n[truncated: the response is longer than ${max} characters]`
  if (/json/i.test(type) || (type === '' && /^\s*[[{]/.test(text))) {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  return text === '' ? `OK: HTTP ${response.status} ${response.statusText}`.trimEnd() : text
}
