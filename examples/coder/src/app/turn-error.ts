/**
 * The text of a failed turn (`TurnResult.error`). The library always sets `error.code`; the app
 * adds what the user can do about the codes that have an obvious fix. Everything else shows the
 * library's own message.
 */
import type { TurnResult } from 'eharness'
import { KEY_ENV } from './provider.ts'

/** Human text of `result.error` (the `stop: 'error'` case). */
export function turnErrorText(error: TurnResult['error']): string {
  if (error === undefined) return 'The turn failed.'
  switch (error.code) {
    case 'EH_PROVIDER_AUTH':
      return `${error.message}\nThe model provider rejected the API key: set ${KEY_ENV.openrouter} or ${KEY_ENV.gateway} (or run /model to pick another provider), then retry.`
    case 'EH_PROVIDER':
      return `Model provider error: ${error.message}`
    case 'EH_LOCK_UNAVAILABLE':
      return `Session storage is unavailable (lock service failed): ${error.message}`
    default:
      return error.message
  }
}
