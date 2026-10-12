export type ApprovalChoice = 'approve' | 'remember' | 'deny';
/** How far "Always allow" reaches: this session, a saved rule of the agent, or of every agent. */
export type AllowScope = 'session' | 'agent' | 'all';
export const ALLOW_SCOPES: ReadonlyArray<{ value: AllowScope; label: string }> = [
	{ value: 'session', label: 'This session' },
	{ value: 'agent', label: 'This agent' },
	{ value: 'all', label: 'All agents' }
];
export const DEFAULT_ALLOW_SCOPE: AllowScope = 'agent';

export type ApprovalAnswerBody = { approved: boolean; reason?: string; note?: string; remember?: 'session'; scope?: AllowScope };

/**
 * The answer body of one choice. The single free-text field means a different thing per choice: the
 * guidance for the agent after a denial (`reason`), or an optional note after an approval (`note`).
 * "Always allow" takes no text.
 */
export function buildAnswer(choice: ApprovalChoice, text = '', scope?: AllowScope): ApprovalAnswerBody {
	const t = text.trim();
	if (choice === 'deny') return { approved: false, ...(t ? { reason: t } : {}) };
	if (choice === 'remember') return { approved: true, remember: 'session', ...(scope ? { scope } : {}) };
	return { approved: true, ...(t ? { note: t } : {}) };
}
