import { describe, expect, test } from 'bun:test';
import { percentOf, sourceLabel, sumUsage } from './usage';

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
