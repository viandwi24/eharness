import { describe, expect, test } from 'bun:test';
import { contextView, formatRate, formatTokens, formatUsd } from './context';

const ctx = { window: 200_000, tokens: 50_000, instructions: 5_000, tools: 15_000, messages: 30_000, summarizeAt: 160_000, hardLimit: 190_000 };

describe('context view', () => {
	test('shares of the window and marker positions', () => {
		const v = contextView(ctx);
		expect(v.pct).toBe(25);
		expect(v.segments.map((s) => s.pct)).toEqual([2.5, 7.5, 15]);
		expect(v.summarizeAtPct).toBe(80);
		expect(v.hardLimitPct).toBe(95);
		expect(v.near).toBe(false);
		expect(v.over).toBe(false);
	});

	test('near and over the compaction threshold', () => {
		expect(contextView({ ...ctx, tokens: 130_000 }).near).toBe(true);
		const over = contextView({ ...ctx, tokens: 170_000 });
		expect(over.near && over.over).toBe(true);
	});

	test('an empty window does not divide by zero', () => {
		expect(contextView({ ...ctx, window: 0 }).pct).toBe(0);
	});

	test('formatting', () => {
		expect(formatTokens(950)).toBe('950');
		expect(formatTokens(1234)).toBe('1.2k');
		expect(formatTokens(42_000)).toBe('42k');
		expect(formatTokens(2_500_000)).toBe('2.5M');
		expect(formatUsd(0)).toBe('$0.00');
		expect(formatUsd(0.0042)).toBe('$0.0042');
		expect(formatUsd(1.234)).toBe('$1.23');
		expect(formatRate(3)).toBe('$3/M');
		expect(formatRate(0.3)).toBe('$0.30/M');
	});
});
