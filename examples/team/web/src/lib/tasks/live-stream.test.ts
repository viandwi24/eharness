/// <reference types="bun" />
import { expect, test } from 'bun:test';
import type { UIMessageChunk } from 'ai';
import { usageOf } from './live-stream.ts';

// The long-turn reproduction of the frozen task panel lives with `followSessionStream`
// (`src/client/follow.test.ts`): delta merging and `clip` keep a 300-step turn under a second.
test('usageOf reads the turn totals', () => {
	expect(usageOf({ type: 'data-eh.usage', data: { steps: 3, costUsd: 0.2 } } as UIMessageChunk)).toEqual({ steps: 3, costUsd: 0.2 });
	expect(usageOf({ type: 'data-eh.usage', data: { steps: 3 } } as UIMessageChunk)).toEqual({ steps: 3 });
	expect(usageOf({ type: 'start-step' })).toBeUndefined();
});
