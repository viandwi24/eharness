/**
 * `schemaCheckedMessages`: a message adapter wrapper that validates every saved message with AI
 * SDK `validateUIMessages`, so a test fails when a turn stores a schema-invalid message (such a
 * message is dropped on the next cold load, spec 03 §7).
 *
 * Imports core only through `src/index.ts` (ADR-0008).
 */
import { safeValidateUIMessages, type UIMessage } from 'ai'
import type { MessageAdapter } from '../index.ts'

/**
 * Throw when `message` is not a valid AI SDK `UIMessage`. Data parts and metadata are not checked
 * (their schemas live in the harness registry); a message of data parts only is skipped.
 */
export async function assertValidUIMessage(message: unknown): Promise<void> {
  const copy = structuredClone(message) as UIMessage
  copy.parts = (copy.parts ?? []).filter((p) => !String(p.type).startsWith('data-'))
  if (copy.parts.length === 0) return
  copy.metadata = undefined
  const result = await safeValidateUIMessages({ messages: [copy] })
  if (!result.success) {
    throw new Error(`stored message ${copy.id} is not a valid UIMessage: ${result.error.message}`)
  }
}

/** Wrap `inner`: `save` rejects (with the reason) a message that fails {@link assertValidUIMessage}. */
export function schemaCheckedMessages(inner: MessageAdapter): MessageAdapter {
  return {
    load: (q) => inner.load(q),
    async save(sessionId, messages) {
      for (const message of messages) await assertValidUIMessage(message)
      return inner.save(sessionId, messages)
    },
    ...(inner.lastId === undefined
      ? {}
      : { lastId: (id: string) => inner.lastId?.(id) ?? Promise.resolve(null) }),
  }
}
