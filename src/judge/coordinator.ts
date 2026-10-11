/**
 * The judge coordinator (ADR-0060, amendment 2026-10-11): lets a `tighten` judge (`guard()`) and a
 * `decide` judge (`modelClassifier()` in permissions auto mode) answer both of their questions in
 * ONE model call for the same tool call, without either subpath importing the other.
 *
 * One coordinator per scope object (the plugins pass `ctx.signal`, the abort signal of the open
 * session, so two sessions never share one and it is released with the session). The tighten side
 * registers a {@link JudgeParticipant}; the decide side, when it judges a call, rides the
 * participant's question along and stores the tighten half of the answer by tool call id; the
 * tighten side then takes it instead of calling its model.
 *
 * @see docs/guides/llm-judge.md
 */

import type { JudgeParticipant, JudgeTightenAnswer } from './judge.ts'
import { judgeKey } from './render.ts'

/** The identity of a call whose answer is stored: the id, and the tool and input it was made for. */
export interface JudgeCallRef {
  toolCallId: string
  toolName: string
  input: unknown
}

/** Per-scope meeting point of a tighten and a decide judge. */
export interface JudgeCoordinator {
  /** A tighten judge announces itself; returns the function that withdraws it. */
  register(participant: JudgeParticipant): () => void
  /** The registered tighten judges. */
  participants(): readonly JudgeParticipant[]
  /** The decide side stores the tighten half of a combined answer for a call. */
  put(call: JudgeCallRef, answer: JudgeTightenAnswer): Promise<void>
  /**
   * The tighten side reads (and removes) the answer stored for the call. `undefined` when none
   * was stored, or when the stored one was made for another tool or input (a reused call id).
   */
  take(call: JudgeCallRef): Promise<JudgeTightenAnswer | undefined>
}

/** Answers kept per coordinator (a session has few calls in flight). */
const MAX_ANSWERS = 200

const coordinators = new WeakMap<object, JudgeCoordinator>()

function create(): JudgeCoordinator {
  const participants = new Set<JudgeParticipant>()
  const answers = new Map<string, { key: string; answer: JudgeTightenAnswer }>()
  const keyOf = (call: JudgeCallRef): Promise<string> => judgeKey(call.toolName, call.input)
  return {
    register(participant) {
      participants.add(participant)
      return () => {
        participants.delete(participant)
      }
    },
    participants: () => [...participants],
    async put(call, answer) {
      const key = await keyOf(call)
      answers.delete(call.toolCallId)
      answers.set(call.toolCallId, { key, answer: structuredClone(answer) })
      while (answers.size > MAX_ANSWERS) answers.delete(answers.keys().next().value as string)
    },
    async take(call) {
      const entry = answers.get(call.toolCallId)
      if (entry === undefined) return undefined
      if (entry.key !== (await keyOf(call))) return undefined
      answers.delete(call.toolCallId)
      return entry.answer
    },
  }
}

/**
 * The coordinator of a scope object. Plugins of one session pass the same object (`ctx.signal`);
 * the coordinator lives as long as that object.
 *
 * @experimental Draft: may change in a minor release (docs/engineering/api-stability.md).
 */
export function judgeCoordinator(scope: object): JudgeCoordinator {
  let found = coordinators.get(scope)
  if (found === undefined) {
    found = create()
    coordinators.set(scope, found)
  }
  return found
}
