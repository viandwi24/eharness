/**
 * Error answers of `eharness/http`: one JSON shape for every status (spec 26 §3).
 *
 * @see docs/specs/26-http.md#3-errors
 */
import { isHarnessError } from '../index.ts'
import type { HttpErrorBody, HttpErrorCode } from './wire.ts'

/** HTTP status of an error code. Unknown codes are `500`. */
export function statusOfCode(code: HttpErrorCode): number {
  switch (code) {
    case 'EH_INVALID_INPUT':
    case 'EH_INVALID_MESSAGE':
    case 'EH_PENDING_RESPONSE':
    case 'EH_HTTP_INVALID_JSON':
    case 'EH_HTTP_INVALID_BODY':
      return 400
    case 'EH_HTTP_UNAUTHORIZED':
      return 401
    case 'EH_HTTP_FORBIDDEN':
      return 403
    case 'EH_HTTP_NOT_FOUND':
      return 404
    case 'EH_HTTP_METHOD_NOT_ALLOWED':
      return 405
    case 'EH_SESSION_BUSY':
    case 'EH_SESSION_CLOSED':
    case 'EH_HTTP_ALREADY_ANSWERED':
    case 'EH_HTTP_DUPLICATE_REQUEST':
      return 409
    case 'EH_HTTP_PAYLOAD_TOO_LARGE':
      return 413
    case 'EH_HTTP_UNSUPPORTED_MEDIA_TYPE':
      return 415
    case 'EH_COMPACTION_FAILED':
    case 'EH_PROVIDER':
    case 'EH_PROVIDER_AUTH':
      return 502
    case 'EH_STORAGE':
    case 'EH_LOCK_UNAVAILABLE':
      return 503
    default:
      return 500
  }
}

/** A JSON error `Response` `{ error: { code, message, details? } }`; the status defaults to {@link statusOfCode}. */
export function httpError(
  code: HttpErrorCode,
  message: string,
  details?: Record<string, unknown>,
  status?: number,
): Response {
  const body: HttpErrorBody = {
    error: { code, message, ...(details === undefined ? {} : { details }) },
  }
  return new Response(JSON.stringify(body), {
    status: status ?? statusOfCode(code),
    headers: { 'content-type': 'application/json' },
  })
}

/** A JSON `Response` of a success body. */
export function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  const out = new Headers(headers)
  out.set('content-type', 'application/json')
  return new Response(JSON.stringify(body), { status, headers: out })
}

const GENERIC: Record<number, string> = {
  500: 'Internal error.',
  502: 'An upstream step failed.',
  503: 'Storage is unavailable.',
}

/**
 * Map a thrown value to an answer. A `HarnessError` keeps its code, and its message for statuses
 * below 500; 5xx answers carry a generic message and no details (the real error goes to
 * `onFailure`). Anything else is `EH_INTERNAL` 500.
 */
export function mapError(error: unknown): { response: Response; failure: boolean } {
  if (isHarnessError(error)) {
    const status = statusOfCode(error.code)
    if (status < 500) {
      return {
        response: httpError(error.code, error.message, error.details, status),
        failure: false,
      }
    }
    return {
      response: httpError(
        error.code,
        GENERIC[status] ?? GENERIC[500] ?? 'Internal error.',
        undefined,
        status,
      ),
      failure: true,
    }
  }
  return { response: httpError('EH_INTERNAL', 'Internal error.', undefined, 500), failure: true }
}
