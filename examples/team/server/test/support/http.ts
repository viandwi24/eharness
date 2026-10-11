/** Request helpers for `eharness/http` chat bodies: the body `id` is the session id of the path. */
export const postAs = (sessionId: string, body: Record<string, unknown>): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: sessionId, ...body }),
})

/** A user message with a fresh id per call (the id of a message is its idempotency key). */
export const userMessage = (text: string): { messages: Array<Record<string, unknown>> } => ({
  messages: [{ id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] }],
})
