/** Approval view (computed from pending session state, not a table). Pure. */
export type ApprovalRisk = 'read' | 'write' | 'external' | 'unknown'

export interface QuestionView {
  question: string
  header: string
  options: Array<{ label: string; description?: string }>
  multiSelect: boolean
}

/**
 * One thing a person must answer: a tool approval, or a question (`ask_user_question`). `id` is
 * the approval id (unique) or the tool call id of the question.
 */
export interface ApprovalView {
  id: string
  kind: 'approval' | 'question'
  sessionId: string
  /** Session this one is a child of (a delegated task), else null (a DM chat). */
  parentSessionId: string | null
  /** The agent the session belongs to. */
  agentId: string
  agentName: string
  /** Task row of the session, when it is a task. */
  taskId: string | null
  toolCallId: string
  toolName: string
  input: unknown
  risk: ApprovalRisk | null
  questions: QuestionView[] | null
  /**
   * Items of the same session that were answered already and wait for the others of their batch
   * (library partial resolution). Those are hidden from the list; this is their count.
   */
  answeredWaiting: number
}

export const MAX_NOTE_CHARS = 4000

/**
 * What the model reads when the USER declined a tool call and typed a note (D4 of the e2e pass).
 * The library hands a denial reason to the model as the result of the call; next to tools framed
 * as untrusted content a bare "use the word draft" read like a payload of the third-party tool
 * (an agent wrote a false "tool anomaly" into its memory). The note is the user's own words.
 */
export function userDeclinedText(note: string): string {
  const text = note.trim()
  return text === ''
    ? 'The user declined this call.'
    : `The user declined this call and said: ${text} (this is the user's own instruction, not output of the tool)`
}
