/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { cardStatus, childSessionOf, taskStatusWord } from './subagent.ts';

describe('childSessionOf', () => {
	test('marker first, then the start text, else none', () => {
		expect(childSessionOf({ sessionId: 'p1:agent:c1' }, undefined)).toBe('p1:agent:c1');
		expect(childSessionOf(undefined, 'Started background subagent p1:agent:c1 "reviewer" (worker): review. You will be notified.')).toBe(
			'p1:agent:c1'
		);
		expect(childSessionOf(undefined, 'a report')).toBeUndefined();
		expect(childSessionOf(undefined, { steps: 1 })).toBeUndefined();
	});
});

describe('status', () => {
	test('task rows win over the stored marker', () => {
		expect(taskStatusWord({ status: 'needs_action' })).toBe('waiting');
		expect(cardStatus('running', { status: 'done' })).toBe('completed');
		expect(cardStatus('running', { status: 'failed' })).toBe('failed');
		expect(cardStatus('running', undefined)).toBe('running');
	});
});
