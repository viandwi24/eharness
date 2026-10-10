/** Approval view (computed from pending session state, not a table). Pure. */
export type ApprovalRisk = 'read' | 'write' | 'external' | 'unknown'

export interface ApprovalView {
  sessionId: string
  approvalId: string
  toolName: string
  input: unknown
  risk: ApprovalRisk
  agentId: string
}
