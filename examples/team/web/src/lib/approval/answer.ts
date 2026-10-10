export type ApprovalChoice = 'approve' | 'remember' | 'deny';
export type ApprovalAnswerBody = { approved: boolean; reason?: string; note?: string; remember?: 'session' };

/**
 * The answer body of one choice. The single free-text field means a different thing per choice: the
 * guidance for the agent after a denial (`reason`), or an optional note after an approval (`note`).
 * "Always allow" takes no text.
 */
export function buildAnswer(choice: ApprovalChoice, text = ''): ApprovalAnswerBody {
	const t = text.trim();
	if (choice === 'deny') return { approved: false, ...(t ? { reason: t } : {}) };
	if (choice === 'remember') return { approved: true, remember: 'session' };
	return { approved: true, ...(t ? { note: t } : {}) };
}
