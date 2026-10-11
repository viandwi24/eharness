/**
 * Request body reading with a hard size limit (spec 26 §5.1).
 *
 * @see docs/specs/26-http.md#51-body-limits
 */
import { httpError } from './errors.ts'

/** Default body limit: 4 MiB. */
export const DEFAULT_MAX_BODY_BYTES: number = 4 * 1024 * 1024

/** Outcome of {@link readJsonBody}: the parsed value or the answer to send. */
export type BodyResult = { ok: true; value: unknown } | { ok: false; response: Response }

/** `true` for `application/json` and `application/*+json` (parameters ignored). */
export function isJsonContentType(request: Request): boolean {
  const type = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  return type === 'application/json' || (type.startsWith('application/') && type.endsWith('+json'))
}

/**
 * Read at most `maxBytes` of the body as text: the `content-length` is checked first, then the
 * stream is counted, so a missing or lying header cannot get past the limit. `undefined` = the
 * limit was exceeded.
 */
export async function readBodyText(
  request: Request,
  maxBytes: number,
): Promise<string | undefined> {
  const declared = request.headers.get('content-length')
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) return undefined
  if (request.body === null) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        void reader.cancel().catch(() => {})
        return undefined
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const all = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    all.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(all)
}

/**
 * Read a JSON body: `415` for a non-JSON content type, `413` over the limit, `400`
 * (`EH_HTTP_INVALID_JSON`) for a body that does not parse. With `optional`, an empty body is `{}`.
 */
export async function readJsonBody(
  request: Request,
  maxBytes: number,
  optional = false,
): Promise<BodyResult> {
  const unsupported = (): BodyResult => ({
    ok: false,
    response: httpError('EH_HTTP_UNSUPPORTED_MEDIA_TYPE', 'Send the body as application/json.'),
  })
  if (!optional && !isJsonContentType(request)) return unsupported()
  const text = await readBodyText(request, maxBytes)
  if (text === undefined) {
    return {
      ok: false,
      response: httpError('EH_HTTP_PAYLOAD_TOO_LARGE', 'The request body is too large.', {
        maxBytes,
      }),
    }
  }
  if (optional && text.trim() === '') return { ok: true, value: {} }
  if (!isJsonContentType(request)) return unsupported()
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false, response: httpError('EH_HTTP_INVALID_JSON', 'The body is not valid JSON.') }
  }
}
