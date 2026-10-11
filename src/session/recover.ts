/**
 * Crash recovery of an interrupted turn (internal): shared by the commit point of a turn (spec 05
 * §9) and `session.recover()`.
 */
import type { ActiveTurn } from '../agent/session-types.ts'
import { createKindMessage } from '../messages/kinds.ts'
import { INTERRUPTED_CRASH } from '../messages/texts.ts'
import { answerDanglingToolParts } from '../messages/tool-parts.ts'
import type { HarnessUIMessage } from '../messages/types.ts'
import type { SessionRuntime } from './runtime.ts'

/** Close `streaming` text / reasoning parts: the model never finished them. */
function closeStreamingParts(message: HarnessUIMessage): HarnessUIMessage {
  let changed = false
  const parts = message.parts.map((part) => {
    const p = part as { type: string; state?: string }
    if ((p.type === 'text' || p.type === 'reasoning') && p.state === 'streaming') {
      changed = true
      return { ...p, state: 'done' } as unknown as typeof part
    }
    return part
  })
  return changed ? { ...message, parts } : message
}

/**
 * Repair what a dead turn left behind (spec 05 §9): answer the dangling tool calls of its
 * assistant message with `INTERRUPTED_CRASH` (ADR-0014), mark it `stop: 'interrupted'`, save an
 * `eh.notice` and emit `turn-end`. Does not touch `state.core.activeTurn` (the caller clears it
 * in its own state write). Returns the saved notice.
 */
export async function recoverInterruptedTurn(
  rt: SessionRuntime,
  persist: (messages: HarnessUIMessage[]) => Promise<HarnessUIMessage[]>,
  stale: ActiveTurn,
  options: { noticeId?: string; startedAt: number },
): Promise<HarnessUIMessage[]> {
  const message = rt.view?.find((m) => m.id === stale.messageId)
  if (message !== undefined) {
    const patched = closeStreamingParts(
      answerDanglingToolParts(structuredClone(message), INTERRUPTED_CRASH),
    )
    const eharness = patched.metadata?.eharness
    if (eharness?.stop === undefined) {
      patched.metadata = {
        ...(patched.metadata ?? {}),
        eharness: { ...(eharness ?? { v: 1, createdAt: options.startedAt }), stop: 'interrupted' },
      }
    }
    await persist([patched])
  } else {
    // the process died before the first step of the turn was saved: keep a placeholder reply so
    // the history shows the interruption and the turn can be retried (regenerate needs a reply).
    // A message of only `step-start` projects to nothing for the model.
    await persist([
      {
        id: stale.messageId,
        role: 'assistant',
        metadata: {
          eharness: {
            v: 1,
            createdAt: stale.startedAt,
            turnId: stale.turnId,
            parentId: stale.userMessageId ?? null,
            stop: 'interrupted',
          },
        },
        parts: [{ type: 'step-start' }],
      } as HarnessUIMessage,
    ])
  }
  const notice = createKindMessage(
    'eh.notice',
    {
      level: 'warning',
      code: 'EH_TURN_INTERRUPTED',
      message: 'The previous turn was interrupted: its process stopped before it finished.',
    },
    {
      id: options.noticeId ?? rt.nextId(),
      turnId: stale.turnId,
      createdAt: Date.now(),
      parentId: stale.messageId,
    },
  )
  const saved = await persist([notice])
  rt.events.emit({
    type: 'turn-end',
    turnId: stale.turnId,
    messageId: stale.messageId,
    stop: 'interrupted',
  })
  return saved
}
