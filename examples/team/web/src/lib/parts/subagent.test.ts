/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { cardStatus, childSessionOf, taskOfCall, taskStatusWord } from './subagent.ts';

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

describe('taskOfCall', () => {
	const rows = [
		{ sessionId: 'dm:a:agent:call-1', status: 'done' as const },
		{ sessionId: 'dm:a:agent:call-2', status: 'running' as const }
	];
	test('by the known child session, else by the tool call the task index registered', () => {
		expect(taskOfCall(rows, 'dm:a:agent:call-2', 'call-1')?.status).toBe('running');
		expect(taskOfCall(rows, undefined, 'call-1')?.status).toBe('done');
		expect(taskOfCall(rows, undefined, 'call-9')).toBeUndefined();
	});
});
