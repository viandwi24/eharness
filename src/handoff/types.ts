/**
 * Types of `eharness/handoff` (spec 32): a request an agent hands to a person, and the store port.
 *
 * @see docs/specs/32-handoff.md
 */

/** What the agent asks for. */
export type HandoffKind = 'decision' | 'question' | 'takeover'

/** Lifecycle of a request. */
export type HandoffStatus = 'open' | 'answered' | 'expired' | 'cancelled'

/** One option a person can choose. */
export interface HandoffOption {
  id: string
  label: string
}

/** The recorded answer. */
export interface HandoffAnswer {
  optionId?: string
  text?: string
  /** Who answered (a person id or any app-defined label). */
  by: string
  /** Epoch ms. */
  at: number
}

/** A question or decision handed to a person while a turn is parked on it. */
export interface HandoffRequest {
  /** `<sessionId>:<waitId>`: stable, so a retried start never creates a second request. */
  id: string
  sessionId: string
  toolCallId: string
  /** The external wait the answer resolves (`session.resolveWait`). */
  waitId: string
  kind: HandoffKind
  title: string
  body: string
  options?: HandoffOption[]
  /** Role names or person ids, app-defined. Empty or missing: anyone. */
  audience?: string[]
  urgency?: 'low' | 'normal' | 'high'
  /** Epoch ms after which {@link expireHandoffs} gives up. */
  expiresAt?: number
  metadata?: Record<string, unknown>
  status: HandoffStatus
  answer?: HandoffAnswer
  /** Epoch ms. */
  createdAt: number
}

/** Input of {@link HandoffStore.create}. */
export type HandoffInput = Omit<HandoffRequest, 'status' | 'answer' | 'createdAt'> & {
  createdAt?: number
}

/** Outcome of `answer` and `cancel`. */
export type HandoffTransition =
  | { ok: true; request: HandoffRequest }
  | {
      ok: false
      reason: 'already-answered' | 'expired' | 'cancelled' | 'not-found'
      /** `true` when `reason` is `'already-answered'`. */
      alreadyAnswered?: true
      request?: HandoffRequest
    }

/** Query of {@link HandoffStore.list}. */
export interface HandoffListQuery {
  status?: HandoffStatus
  sessionId?: string
  /** Requests addressed to any of these names, plus requests without an audience. */
  audience?: string[]
  /** Default 50. */
  limit?: number
  cursor?: string
}

/** One page of {@link HandoffStore.list}, oldest first. */
export interface HandoffListResult {
  items: HandoffRequest[]
  nextCursor?: string
}

/**
 * Storage port for handoff requests. Every method is async. `answer` and `cancel` are
 * compare-and-set transitions out of `open`: with parallel callers exactly one wins.
 *
 * @see docs/specs/32-handoff.md#2-the-store-port
 */
export interface HandoffStore {
  /** Idempotent by `id`: an existing request is returned with `created: false`. */
  create(input: HandoffInput): Promise<{ request: HandoffRequest; created: boolean }>
  get(id: string): Promise<HandoffRequest | undefined>
  list(query?: HandoffListQuery): Promise<HandoffListResult>
  /** Only an `open` request can be answered. */
  answer(id: string, answer: HandoffAnswer): Promise<HandoffTransition>
  /** Only an `open` request can be cancelled. */
  cancel(id: string): Promise<HandoffTransition>
  /** Mark every open request with `expiresAt <= now` expired and return them. */
  expire(now: number): Promise<HandoffRequest[]>
}
