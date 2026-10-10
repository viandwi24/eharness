// STATIC LIST: the model catalog (`GET /models`, spec 5.1 settings) is not served yet.
// `null` means "the workspace default". Replace with the API list when it exists.
export const modelOptions: { id: string | null; label: string }[] = [
	{ id: null, label: 'Workspace default' },
	{ id: 'deepseek/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash' },
	{ id: 'deepseek/deepseek-v4-pro-0813', label: 'DeepSeek V4 Pro' },
	{ id: 'anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5' },
	{ id: 'anthropic/claude-haiku-5.5', label: 'Claude Haiku 5.5' },
	{ id: 'google/gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
	{ id: 'openai/gpt-5.6-sol', label: 'GPT-5.6 Sol' }
];

export const agentColors = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#64748b'];
