/** Answer an item of the attention queue (`POST /attention/{id}/answer`, `eharness/http`). */
export interface Answerable {
  id: string
  sessionId: string
}

type Requester = { request(path: string, init?: RequestInit): Response | Promise<Response> }

/**
 * `answer` is the wire answer without `kind` for the two team shapes: an approval decision
 * (`{ approved, ... }`) or a question (`{ answers }`).
 */
export function attn(
  app: Requester,
  item: Answerable | undefined,
  answer: Record<string, unknown>,
): Promise<Response> {
  const kind = 'answers' in answer ? 'question' : 'approval'
  return Promise.resolve(
    app.request(`/attention/${encodeURIComponent(item?.id ?? 'none')}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: item?.sessionId, answer: { kind, ...answer } }),
    }),
  )
}
