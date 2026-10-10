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
