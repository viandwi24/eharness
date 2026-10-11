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
