/**
 * Small helpers shared by the core (internal). `errorText` and `isRecord` are also re-exported from
 * `src/index.ts` for the subpath modules; the rest stays internal.
 */

/**
 * A non-null, non-array object (`typeof` alone also accepts `null` and arrays). A small public
 * helper (re-exported by `eharness`) so subpath modules do not carry their own copy.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The message of an `Error`, the string form of anything else. A small public helper (re-exported
 * by `eharness`): the one text of a caught error in tool results, warnings and logs.
 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `timer.unref()` where the runtime has it (Node, Bun), so a pending timer never holds the process. */
export function unref(timer: unknown): void {
  ;(timer as { unref?: () => void } | undefined)?.unref?.()
}

/** Why `signal` aborted, as text: a string reason, an `Error` message, else `'aborted'`. */
export function abortReason(signal: AbortSignal): string {
  const reason: unknown = signal.reason
  if (typeof reason === 'string') return reason
  if (reason instanceof Error && reason.message.length > 0) return reason.message
  return 'aborted'
}
