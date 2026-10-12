/**
 * Instruction turns (UX pass): the prompt of a task, a program run, a rehearsal or a heartbeat is
 * written by the system, not typed by a person. The server marks that user message with the app
 * flag `metadata.app.instruction = true`, so the web shows it as a collapsed Instructions card
 * without guessing from the position of the message.
 *
 * `session.send()` takes no app metadata (only `enqueue` does), so the caller marks the session
 * right before it sends and the message adapter stamps the next user message it stores
 * (`sqliteMessages`). A mark lives for one send: it is dropped when the send settles, so a person's
 * later message in the same session is never flagged. Routine fires use `enqueue(..., { metadata })`
 * directly (`INSTRUCTION_METADATA`).
 */

/** The app metadata of an instruction message (`metadata.app`). */
export const INSTRUCTION_METADATA = { instruction: true } as const

const pending = new Set<string>()

/** The next user message stored for `sessionId` is an instruction. */
export function markInstruction(sessionId: string): void {
  pending.add(sessionId)
}

/** Forget the mark (the send settled); true when it had not been used. */
export function clearInstruction(sessionId: string): boolean {
  return pending.delete(sessionId)
}

/** Take the mark: true once per `markInstruction`. */
export function takeInstruction(sessionId: string): boolean {
  return pending.delete(sessionId)
}

/** `fn` with the session marked for its send; the mark never outlives the call. */
export async function withInstruction<T>(sessionId: string, fn: () => Promise<T> | T): Promise<T> {
  markInstruction(sessionId)
  try {
    return await fn()
  } finally {
    clearInstruction(sessionId)
  }
}

/** Does a stored message carry the flag? */
export const isInstruction = (metadata: unknown): boolean =>
  typeof metadata === 'object' &&
  metadata !== null &&
  (metadata as { app?: { instruction?: unknown } }).app?.instruction === true
