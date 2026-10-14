import type {
  HandoffAnswer,
  HandoffInput,
  HandoffListQuery,
  HandoffListResult,
  HandoffRequest,
  HandoffStore,
  HandoffTransition,
} from './types.ts'

const clone = (r: HandoffRequest): HandoffRequest => structuredClone(r)

const keyOf = (r: HandoffRequest): string => `${String(r.createdAt).padStart(16, '0')}|${r.id}`

/**
 * In-memory {@link HandoffStore} (tests, single process, examples).
 *
 * @example
 * ```ts
 * const store = memoryHandoffStore()
 * ```
 * @see docs/specs/32-handoff.md#2-the-store-port
 */
export function memoryHandoffStore(): HandoffStore {
  const rows = new Map<string, HandoffRequest>()

  const leave = (
    id: string,
    to: 'answered' | 'cancelled',
    answer?: HandoffAnswer,
  ): HandoffTransition => {
    const row = rows.get(id)
    if (row === undefined) return { ok: false, reason: 'not-found' }
    if (row.status !== 'open') {
      const reason = row.status === 'answered' ? 'already-answered' : row.status
      return {
        ok: false,
        reason,
        ...(reason === 'already-answered' ? { alreadyAnswered: true as const } : {}),
        request: clone(row),
      }
    }
    row.status = to
    if (answer !== undefined) row.answer = structuredClone(answer)
    return { ok: true, request: clone(row) }
  }

  return {
    async create(input: HandoffInput): Promise<{ request: HandoffRequest; created: boolean }> {
      const existing = rows.get(input.id)
      if (existing !== undefined) return { request: clone(existing), created: false }
      const row: HandoffRequest = structuredClone({
        ...input,
        status: 'open',
        createdAt: input.createdAt ?? Date.now(),
      })
      rows.set(row.id, row)
      return { request: clone(row), created: true }
    },
    async get(id: string): Promise<HandoffRequest | undefined> {
      const row = rows.get(id)
      return row && clone(row)
    },
    async list(query: HandoffListQuery = {}): Promise<HandoffListResult> {
      const limit = Math.max(1, query.limit ?? 50)
      const matching = [...rows.values()]
        .filter((r) => query.status === undefined || r.status === query.status)
        .filter((r) => query.sessionId === undefined || r.sessionId === query.sessionId)
        .filter(
          (r) =>
            query.audience === undefined ||
            r.audience === undefined ||
            r.audience.length === 0 ||
            r.audience.some((a) => query.audience?.includes(a)),
        )
        .sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1))
        .filter((r) => query.cursor === undefined || keyOf(r) > query.cursor)
      const page = matching.slice(0, limit)
      const last = page[page.length - 1]
      return {
        items: page.map(clone),
        ...(matching.length > limit && last !== undefined ? { nextCursor: keyOf(last) } : {}),
      }
    },
    async answer(id: string, answer: HandoffAnswer): Promise<HandoffTransition> {
      return leave(id, 'answered', answer)
    },
    async cancel(id: string): Promise<HandoffTransition> {
      return leave(id, 'cancelled')
    },
    async expire(now: number): Promise<HandoffRequest[]> {
      const out: HandoffRequest[] = []
      for (const row of rows.values()) {
        if (row.status === 'open' && row.expiresAt !== undefined && row.expiresAt <= now) {
          row.status = 'expired'
          out.push(clone(row))
        }
      }
      return out
    },
  }
}
