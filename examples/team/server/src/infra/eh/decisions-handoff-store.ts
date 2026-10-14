/**
 * A `HandoffStore` (eharness/handoff, spec 32) over the team's `decisions` table, so the library's
 * `resolveHandoff` can answer the decisions that park a run on an external wait.
 *
 * No migration: the table already has everything but a few handoff-only fields (tool call id,
 * audience, expiry...), which ride in `payload.handoff` of rows created through `create`. Rows the
 * team creates itself (`createEscalation`, `createAmendment`) are read as handoff requests too.
 *
 * Mapping: `approved` and `rejected` are `answered` (the option id `rejected` is a rejection, any
 * other answer approves); a cancelled request is stored as `expired` with `outcome.cancelled`.
 * The request id is the decision id.
 *
 * The team's own claim (the outcome, an amendment's narrowed grant, who decided) rides in the same
 * compare-and-set as the library's `answer` through `extras.metadata.claim` (`claimMetadata`).
 */
import type {
  HandoffAnswer,
  HandoffAnswerExtras,
  HandoffInput,
  HandoffListQuery,
  HandoffListResult,
  HandoffOption,
  HandoffRequest,
  HandoffStore,
  HandoffTransition,
} from 'eharness/handoff'
import type { DecisionPatch, DecisionStore } from '../../app/ports.ts'
import type { Decision, DecisionOutcome } from '../../domain/decisions.ts'

/** The option id that rejects (every other answer approves). */
export const REJECT_OPTION = 'rejected'

interface Extra {
  toolCallId?: string
  waitId?: string
  kind?: HandoffRequest['kind']
  options?: HandoffOption[]
  audience?: string[]
  urgency?: HandoffRequest['urgency']
  expiresAt?: number
  metadata?: Record<string, unknown>
}

/** What the team's own claim adds to the answer's compare-and-set. */
export interface ClaimExtras {
  outcome?: DecisionOutcome | undefined
  payload?: Decision['payload'] | undefined
  programId?: string | null | undefined
  /** Stored as `decidedBy` (default: the answer's `by`). */
  decidedBy?: string | undefined
}

/** The `metadata` patch that carries a {@link ClaimExtras} into `answer`. */
export function claimMetadata(claim: ClaimExtras): Record<string, unknown> {
  return { claim }
}

const LIMIT = 100_000
const keyOf = (r: HandoffRequest): string => `${String(r.createdAt).padStart(16, '0')}|${r.id}`

export function decisionHandoffStore(decisions: DecisionStore): HandoffStore {
  const extraOf = (d: Decision): Extra =>
    ((d.payload as { handoff?: Extra }).handoff ?? {}) as Extra

  const toRequest = (d: Decision): HandoffRequest => {
    const extra = extraOf(d)
    const payload = d.payload as { question?: string; options?: unknown }
    const labels = Array.isArray(payload.options) ? (payload.options as string[]) : []
    const options: HandoffOption[] | undefined =
      extra.options ??
      (d.kind === 'escalation' && labels.length > 0
        ? [...labels.map((l) => ({ id: l, label: l })), { id: REJECT_OPTION, label: REJECT_OPTION }]
        : undefined)
    const cancelled = d.status === 'expired' && (d.outcome as { cancelled?: boolean })?.cancelled
    const status: HandoffRequest['status'] =
      d.status === 'open'
        ? 'open'
        : d.status === 'expired'
          ? cancelled
            ? 'cancelled'
            : 'expired'
          : 'answered'
    const answered = d.status === 'approved' || d.status === 'rejected'
    return {
      id: d.id,
      sessionId: d.sessionId ?? '',
      toolCallId: extra.toolCallId ?? '',
      waitId: d.waitId ?? extra.waitId ?? '',
      kind: extra.kind ?? (d.kind === 'escalation' ? 'question' : 'decision'),
      title: d.title,
      body: d.body,
      ...(options === undefined ? {} : { options }),
      ...(extra.audience === undefined ? {} : { audience: extra.audience }),
      ...(extra.urgency === undefined ? {} : { urgency: extra.urgency }),
      ...(extra.expiresAt === undefined ? {} : { expiresAt: extra.expiresAt }),
      ...(extra.metadata === undefined ? {} : { metadata: extra.metadata }),
      status,
      ...(answered
        ? {
            answer: {
              optionId:
                d.outcome?.decision ?? (d.status === 'rejected' ? REJECT_OPTION : undefined),
              ...(d.decisionNote ? { text: d.decisionNote } : {}),
              by: d.decidedBy ?? '',
              at: d.decidedAt ?? 0,
            } as HandoffAnswer,
          }
        : {}),
      createdAt: d.createdAt,
    }
  }

  const closed = (d: Decision): HandoffTransition => {
    const request = toRequest(d)
    const reason =
      request.status === 'answered'
        ? 'already-answered'
        : (request.status as 'expired' | 'cancelled')
    return {
      ok: false,
      reason,
      ...(reason === 'already-answered' ? { alreadyAnswered: true as const } : {}),
      request,
    }
  }

  const leave = (
    id: string,
    patch: Omit<DecisionPatch, 'decidedAt'> & { decidedAt: number },
  ): HandoffTransition => {
    const row = decisions.get(id)
    if (row === undefined) return { ok: false, reason: 'not-found' }
    if (row.status !== 'open') return closed(row)
    const next = decisions.decide(id, patch)
    if (next !== undefined) return { ok: true, request: toRequest(next) }
    const now = decisions.get(id)
    return now === undefined ? { ok: false, reason: 'not-found' } : closed(now)
  }

  return {
    async create(input: HandoffInput): Promise<{ request: HandoffRequest; created: boolean }> {
      const existing = decisions.get(input.id)
      if (existing !== undefined) return { request: toRequest(existing), created: false }
      const handoff: Extra = {
        toolCallId: input.toolCallId,
        waitId: input.waitId,
        kind: input.kind,
        ...(input.options === undefined ? {} : { options: input.options }),
        ...(input.audience === undefined ? {} : { audience: input.audience }),
        ...(input.urgency === undefined ? {} : { urgency: input.urgency }),
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      }
      const agentId = (input.metadata as { agentId?: unknown } | undefined)?.agentId
      const row = decisions.insert({
        id: input.id,
        kind: 'escalation',
        title: input.title,
        body: input.body,
        agentId: typeof agentId === 'string' ? agentId : 'handoff',
        sessionId: input.sessionId,
        programId: null,
        // the column is unique per wait; the handoff id already is (`<session>:<wait>`)
        waitId: null,
        payload: {
          question: input.body,
          options: (input.options ?? []).map((o) => o.label),
          source: 'agent',
          handoff,
        } as never,
        createdAt: input.createdAt ?? Date.now(),
      })
      return { request: toRequest(row), created: true }
    },

    async get(id: string): Promise<HandoffRequest | undefined> {
      const row = decisions.get(id)
      return row === undefined ? undefined : toRequest(row)
    },

    async list(query: HandoffListQuery = {}): Promise<HandoffListResult> {
      const limit = Math.max(1, query.limit ?? 50)
      const matching = decisions
        .list({
          ...(query.sessionId === undefined ? {} : { sessionId: query.sessionId }),
          limit: LIMIT,
        })
        .map(toRequest)
        .filter((r) => query.status === undefined || r.status === query.status)
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
        items: page,
        ...(matching.length > limit && last !== undefined ? { nextCursor: keyOf(last) } : {}),
      }
    },

    async answer(
      id: string,
      answer: HandoffAnswer,
      patch?: HandoffAnswerExtras,
    ): Promise<HandoffTransition> {
      const { claim, ...rest } = patch?.metadata ?? {}
      const extras = (claim ?? {}) as ClaimExtras
      const optionId = answer.optionId
      // any other metadata key is stored with the request (`payload.handoff.metadata`)
      let payload = extras.payload
      const row = decisions.get(id)
      if (Object.keys(rest).length > 0 && row !== undefined) {
        const base = (payload ?? row.payload) as { handoff?: Extra }
        payload = {
          ...base,
          handoff: { ...base.handoff, metadata: { ...base.handoff?.metadata, ...rest } },
        } as unknown as Decision['payload']
      }
      return leave(id, {
        status: optionId === REJECT_OPTION ? 'rejected' : 'approved',
        decidedBy: extras.decidedBy ?? answer.by,
        decidedAt: answer.at,
        note: answer.text ?? '',
        outcome: extras.outcome ?? {
          decision: optionId ?? 'approved',
        },
        ...(payload === undefined ? {} : { payload }),
        ...(extras.programId === undefined ? {} : { programId: extras.programId }),
      })
    },

    async cancel(id: string): Promise<HandoffTransition> {
      return leave(id, {
        status: 'expired',
        decidedBy: 'handoff',
        decidedAt: Date.now(),
        note: '',
        outcome: { decision: 'cancelled', cancelled: true } as DecisionOutcome,
      })
    },

    async expire(now: number): Promise<HandoffRequest[]> {
      const out: HandoffRequest[] = []
      for (const d of decisions.list({ status: 'open', limit: LIMIT })) {
        const expiresAt = extraOf(d).expiresAt
        if (expiresAt === undefined || expiresAt > now) continue
        const next = decisions.decide(d.id, {
          status: 'expired',
          decidedBy: 'handoff',
          decidedAt: now,
          note: '',
        })
        if (next !== undefined) out.push(toRequest(next))
      }
      return out
    },
  }
}
