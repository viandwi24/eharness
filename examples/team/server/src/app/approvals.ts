/** Cross-session approvals: list what waits for a person and answer it from any instance. */
import type { ApprovalAnswer, ApprovalOutcome, ApprovalView } from '../domain/approvals.ts'
import { MAX_NOTE_CHARS } from '../domain/approvals.ts'
import { conflict, invalid, notFound } from '../domain/errors.ts'
import { OWNER } from './chat.ts'
import type { Deps } from './ports.ts'

export function listApprovals(deps: Deps): Promise<ApprovalView[]> {
  return deps.team.approvals()
}

/**
 * `id` is the approval id (or the tool call id of a question). `sessionId` disambiguates in the
 * rare case that two sessions carry the same id.
 */
export async function answerApproval(
  deps: Deps,
  id: string,
  answer: ApprovalAnswer,
  sessionId?: string,
): Promise<{ view: ApprovalView; outcome: ApprovalOutcome }> {
  if (answer.kind === 'approval' && answer.note !== undefined) {
    if (answer.note.length > MAX_NOTE_CHARS) {
      throw invalid(`note is longer than ${MAX_NOTE_CHARS} characters`, 'NOTE_TOO_LONG')
    }
  }
  const found = (await deps.team.approvals(sessionId === undefined ? {} : { sessionId })).filter(
    (a) => a.id === id && (sessionId === undefined || a.sessionId === sessionId),
  )
  if (found.length === 0) throw notFound('approval', id)
  if (found.length > 1) {
    throw conflict(`several sessions have an item ${id}: pass sessionId`, 'AMBIGUOUS_APPROVAL')
  }
  const view = found[0] as ApprovalView
  if (view.kind !== answer.kind) {
    throw invalid(`${id} is a ${view.kind}: answer it with a ${view.kind} body`, 'WRONG_KIND')
  }
  const outcome = await deps.team.answer(view, answer, OWNER)
  return { view, outcome }
}
