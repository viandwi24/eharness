/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { cardStatus, childSessionOf, resolveStatus, taskOfCall, taskStatusWord } from './subagent.ts';

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

describe('resolveStatus', () => {
	const base = { task: undefined, run: { status: 'running' as const }, progress: undefined, toolState: undefined, tasksLoaded: true };
	test('the task row wins', () => {
		expect(resolveStatus({ ...base, task: { status: 'timed_out' }, toolState: 'output-available' })).toBe('timed_out');
	});
	test('a running marker stays while the call runs', () => {
		expect(resolveStatus({ ...base, toolState: 'input-available' })).toBe('running');
	});
	test('a finished call without a task row is not left spinning', () => {
		expect(resolveStatus({ ...base, toolState: 'output-available' })).toBe('completed');
		expect(resolveStatus({ ...base, toolState: 'output-error' })).toBe('failed');
		expect(resolveStatus({ ...base, run: undefined, progress: { status: 'running' }, toolState: 'output-available' })).toBe('completed');
	});
	test('before the task list is loaded the marker is kept', () => {
		expect(resolveStatus({ ...base, toolState: 'output-available', tasksLoaded: false })).toBe('running');
	});
	test('a background start says nothing about the child', () => {
		expect(resolveStatus({ ...base, toolState: 'output-available', background: true })).toBe('running');
	});
	test('a final marker is kept', () => {
		expect(resolveStatus({ ...base, run: { status: 'stopped' }, toolState: 'output-available' })).toBe('stopped');
	});
});
