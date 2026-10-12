import { describe, expect, test } from 'bun:test';
import { monthText, percentOf, sinceText, sourceLabel, sumUsage } from './usage';

test('sumUsage adds every field and tolerates missing ones', () => {
	expect(sumUsage([{ inputTokens: 1, outputTokens: 2, totalTokens: 3, costUsd: 0.5, turns: 1 }, { costUsd: 0.25, turns: 2 }, {}])).toEqual({
		inputTokens: 1, outputTokens: 2, totalTokens: 3, costUsd: 0.75, turns: 3
	});
});

describe('sourceLabel / percentOf', () => {
	test('names the sources and falls back to the raw id', () => {
		expect(sourceLabel('program').label).toBe('Program runs');
		expect(sourceLabel('x').label).toBe('x');
		expect(percentOf(1, 4)).toBe(25);
		expect(percentOf(1, 0)).toBe(0);
	});
});

test('monthText and sinceText say where the numbers come from', () => {
	const usd = (n: number): string => `$${n}`;
	expect(monthText(null, usd)).toBe('');
	expect(monthText({ spentUsd: 3, limitUsd: 10 }, usd)).toBe('$3 of $10 this month');
	expect(monthText({ spentUsd: 3, limitUsd: null }, usd)).toBe('$3 this month (no limit)');
	expect(sinceText(null)).toContain('No calls');
	expect(sinceText(Date.UTC(2026, 9, 5, 12))).toMatch(/^Breakdown since .*older calls are pruned/);
});
