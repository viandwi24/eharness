/**
 * `describeError`: user-safe error texts for `error` chunks and `eh.notice` messages (internal).
 *
 * @see docs/specs/10-errors-and-stop-reasons.md#3-describeerror
 */
import { APICallError, LoadAPIKeyError, StreamProviderError } from 'ai'
import type { HarnessErrorCode } from '../codes.ts'
import { isHarnessError } from '../errors.ts'
import {
  errorChain,
  messageOf,
  redactProviderMessage,
  statusOf,
} from '../internal/provider-errors.ts'

/** Fallback text when nothing user-safe can be derived. */
export const UNEXPECTED_ERROR_TEXT = 'Unexpected error (see server logs)'

/** Hint of an authentication failure of the AI Gateway (the default provider of string model ids). */
const GATEWAY_AUTH_TEXT =
  'AI Gateway authentication failed: set the AI_GATEWAY_API_KEY environment variable ' +
  '(or pass `apiKey` to createGateway; on Vercel link the project for OIDC).'

/** Hint added to a provider 401/403. */
const AUTH_HINT = ' Check the provider API key and its access to the model.'

/**
 * `GatewayAuthenticationError` of `@ai-sdk/gateway`. The class is not re-exported by `ai`, and
 * `@ai-sdk/gateway` is not our dependency, so this checks the same registry symbol its own
 * `isInstance` checks (`Symbol.for(...)`: shared across package copies), never the name.
 */
const GATEWAY_AUTH_MARKER = Symbol.for('vercel.ai.gateway.error.GatewayAuthenticationError')

function isGatewayAuthError(error: object): boolean {
  return (error as Record<symbol, unknown>)[GATEWAY_AUTH_MARKER] === true
}

/** A user-safe error text and the stable code of its kind. */
export interface DescribedError {
  /** `EH_*` code of a `HarnessError`; `EH_PROVIDER_AUTH`, `EH_PROVIDER` or `EH_RUN_FAILED` otherwise. */
  code: HarnessErrorCode
  /** The user-safe message (same text as {@link describeError}). */
  message: string
}

/**
 * Map any error to a user-safe message and a code.
 *
 * - `HarnessError`s carry texts written by eharness: message and code returned as-is.
 * - An AI Gateway authentication error (no key, invalid key) or an AI SDK `LoadAPIKeyError`, or a
 *   provider 401/403: code `EH_PROVIDER_AUTH`; the gateway text names `AI_GATEWAY_API_KEY`.
 * - Walks `.cause` chains and AI SDK `RetryError.lastError` / `errors` (same classification as
 *   overflow detection); an error with an HTTP status gets a prefix: `Provider rejected the
 *   request:` (400, 401, 402, 403, 404, 422), `Rate limited:` (429), `Provider unavailable:`
 *   (5xx), followed by the provider's own message for `APICallError` / `StreamProviderError`
 *   (URLs, query strings and key-like tokens redacted, capped at 300 characters) and by
 *   `HTTP <status>` for any other (duck-typed) error. Code `EH_PROVIDER` (`EH_PROVIDER_AUTH` for
 *   401/403).
 * - Never includes headers, API keys, request bodies or stack traces.
 * - Falls back to {@link UNEXPECTED_ERROR_TEXT} with code `EH_RUN_FAILED`; `log` receives the
 *   full error then.
 */
export function describeErrorWithCode(
  error: unknown,
  log?: (message: string, data?: Record<string, unknown>) => void,
): DescribedError {
  const errors = errorChain(error)
  for (const candidate of errors) {
    if (isHarnessError(candidate)) return { code: candidate.code, message: candidate.message }
  }
  for (const candidate of errors) {
    if (isGatewayAuthError(candidate)) {
      return { code: 'EH_PROVIDER_AUTH', message: GATEWAY_AUTH_TEXT }
    }
    if (LoadAPIKeyError.isInstance(candidate)) {
      return {
        code: 'EH_PROVIDER_AUTH',
        message: `Provider API key missing: ${redactProviderMessage(candidate.message)}`,
      }
    }
  }
  for (const candidate of errors) {
    const status = statusOf(candidate)
    if (status === undefined) continue
    // only AI SDK provider errors carry a provider message worth showing; it is redacted and
    // capped. Any other error with a status (fetch, gateways, custom wrappers) is described
    // generically: its message may hold URLs with keys, connection strings, …
    const trusted = APICallError.isInstance(candidate) || StreamProviderError.isInstance(candidate)
    const raw = trusted ? messageOf(candidate) : undefined
    const message = raw === undefined ? `HTTP ${status}` : redactProviderMessage(raw)
    if (status === 429) return { code: 'EH_PROVIDER', message: `Rate limited: ${message}` }
    if (status >= 500 && status <= 599) {
      return { code: 'EH_PROVIDER', message: `Provider unavailable: ${message}` }
    }
    if (status === 401 || status === 403) {
      return {
        code: 'EH_PROVIDER_AUTH',
        message: `Provider rejected the request: ${message}.${AUTH_HINT}`,
      }
    }
    if ([400, 402, 404, 422].includes(status)) {
      return { code: 'EH_PROVIDER', message: `Provider rejected the request: ${message}` }
    }
  }
  log?.('eharness: unexpected error', { error })
  return { code: 'EH_RUN_FAILED', message: UNEXPECTED_ERROR_TEXT }
}

/** Like {@link describeErrorWithCode}, the message only (spec 10 §3). */
export function describeError(
  error: unknown,
  log?: (message: string, data?: Record<string, unknown>) => void,
): string {
  return describeErrorWithCode(error, log).message
}

/** `TurnResult.error` of a failed turn: always a code, `details` of a `HarnessError`. */
export interface TurnError {
  code: HarnessErrorCode
  message: string
  details?: Record<string, unknown>
}

/**
 * The `TurnResult.error` of any error (internal): {@link describeErrorWithCode} plus the
 * structured `details` of a `HarnessError`.
 */
export function toTurnError(
  error: unknown,
  log?: (message: string, data?: Record<string, unknown>) => void,
): TurnError {
  const { code, message } = describeErrorWithCode(error, log)
  if (!isHarnessError(error) || error.details === undefined) return { code, message }
  return { code, message, details: structuredClone(error.details) }
}
