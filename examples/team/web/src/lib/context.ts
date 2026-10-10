import type { components } from './api/schema';

export type ChatStats = components['schemas']['ChatStats'];

/** `1234` -> `1.2k`, `2_500_000` -> `2.5M`. */
export function formatTokens(n: number): string {
	if (!Number.isFinite(n) || n < 0) return '0';
	if (n < 1000) return String(Math.round(n));
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
	return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** USD with enough digits for small amounts: `$0.0042`, `$0.31`, `$12.40`. */
export function formatUsd(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return '$0.00';
	if (n < 0.01) return `$${n.toFixed(4)}`;
	return `$${n.toFixed(2)}`;
}

/** Catalog prices are USD per 1M tokens. */
export function formatRate(perMillion: number): string {
	return `$${perMillion < 1 ? perMillion.toFixed(2) : perMillion.toFixed(perMillion % 1 === 0 ? 0 : 2)}/M`;
}

export type ContextSegment = { key: 'instructions' | 'tools' | 'messages'; label: string; tokens: number; pct: number };

export type ContextView = {
	/** Used share of the window, 0..100 (rounded). */
	pct: number;
	segments: ContextSegment[];
	/** Position of the compaction threshold and the hard limit on the bar, 0..100. */
	summarizeAtPct: number;
	hardLimitPct: number;
	/** Compaction is due soon (>= 80% of the threshold) or already past it. */
	near: boolean;
	over: boolean;
};

const share = (tokens: number, window: number): number => (window > 0 ? Math.min(100, (tokens / window) * 100) : 0);

/** Numbers the context bar and the composer indicator show, from `GET /agents/{id}/stats`. */
export function contextView(c: ChatStats['context']): ContextView {
	const parts: Array<[ContextSegment['key'], string, number]> = [
		['instructions', 'Instructions', c.instructions],
		['tools', 'Tools', c.tools],
		['messages', 'Messages', c.messages]
	];
	return {
		pct: Math.round(share(c.tokens, c.window)),
		segments: parts.map(([key, label, tokens]) => ({ key, label, tokens, pct: share(tokens, c.window) })),
		summarizeAtPct: share(c.summarizeAt, c.window),
		hardLimitPct: share(c.hardLimit, c.window),
		near: c.summarizeAt > 0 && c.tokens >= c.summarizeAt * 0.8,
		over: c.summarizeAt > 0 && c.tokens >= c.summarizeAt
	};
}
