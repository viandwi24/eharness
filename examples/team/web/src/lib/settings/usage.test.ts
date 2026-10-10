import { expect, test } from 'bun:test';
import { sumUsage } from './usage';

test('sumUsage adds every field and tolerates missing ones', () => {
	expect(sumUsage([{ inputTokens: 1, outputTokens: 2, totalTokens: 3, costUsd: 0.5, turns: 1 }, { costUsd: 0.25, turns: 2 }, {}])).toEqual({
		inputTokens: 1, outputTokens: 2, totalTokens: 3, costUsd: 0.75, turns: 3
	});
});
