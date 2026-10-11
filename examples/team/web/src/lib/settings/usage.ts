export type Usage = { inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number; turns: number };

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, turns: 0 });

/** Sum the `session.stats().usage` of several agents (the shape served by `GET /agents/{id}/stats`). */
export function sumUsage(items: readonly Partial<Usage>[]): Usage {
	const out = emptyUsage();
	for (const u of items) {
		out.inputTokens += u.inputTokens ?? 0;
		out.outputTokens += u.outputTokens ?? 0;
		out.totalTokens += u.totalTokens ?? 0;
		out.costUsd += u.costUsd ?? 0;
		out.turns += u.turns ?? 0;
	}
	return out;
}

/** The sources of `GET /usage`, as the settings page names them. */
export const SOURCE_LABELS: Record<string, { label: string; unit: string }> = {
	chat: { label: 'Chats', unit: 'turns' },
	task: { label: 'Tasks', unit: 'tasks' },
	delegated: { label: 'Delegated work', unit: 'runs' },
	routine: { label: 'Routine runs', unit: 'runs' },
	program: { label: 'Program runs', unit: 'runs' }
};

export const sourceLabel = (source: string): { label: string; unit: string } => SOURCE_LABELS[source] ?? { label: source, unit: 'runs' };

/** Share of `part` in `whole` as a whole percent (0 when `whole` is 0). */
export const percentOf = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * 100) : 0);
