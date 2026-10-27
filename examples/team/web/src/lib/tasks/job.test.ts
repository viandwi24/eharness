/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { jobStats } from './job.ts';

test('the first chunk counts from 1 and adds the running turn', () => {
	expect(jobStats({ chunk: 0, steps: 0, costUsd: 0 })).toEqual({ chunk: 1, steps: 0, costUsd: 0 });
	expect(jobStats({ chunk: 0, steps: 0, costUsd: 0 }, { steps: 37, costUsd: 0.42 })).toEqual({ chunk: 1, steps: 37, costUsd: 0.42 });
	expect(jobStats({ chunk: 2, steps: 160, costUsd: 1.5 }, { steps: 4 })).toEqual({ chunk: 3, steps: 164, costUsd: 1.5 });
});
