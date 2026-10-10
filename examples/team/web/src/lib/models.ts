// STATIC LIST: the model catalog (`GET /models`, spec 5.1 settings) is not served yet.
// `null` means "the workspace default". Replace with the API list when it exists.
export const modelOptions: { id: string | null; label: string }[] = [
	{ id: null, label: 'Workspace default' },
	{ id: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5' },
	{ id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5' },
	{ id: 'anthropic/claude-opus-4.1', label: 'Claude Opus 4.1' }
];

export const agentColors = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#64748b'];

export const permissionModes: { id: 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypassPermissions'; label: string; hint: string }[] = [
	{ id: 'default', label: 'Default', hint: 'Ask before risky tools.' },
	{ id: 'acceptEdits', label: 'Accept edits', hint: 'File edits go through without asking.' },
	{ id: 'plan', label: 'Plan', hint: 'Read-only: the agent plans, nothing changes.' },
	{ id: 'dontAsk', label: 'Do not ask', hint: 'Only pre-allowed tools run; the rest is denied.' },
	{ id: 'bypassPermissions', label: 'Bypass', hint: 'Everything runs without asking. Use with care.' }
];
