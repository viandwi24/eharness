import { describe, expect, test } from 'bun:test';
import { dueLabel, queueStatus } from './queue';

describe('queued tasks', () => {
	test('due labels', () => {
		const late = dueLabel(Date.parse('2026-01-02T00:00:00Z'), Date.parse('2026-02-01T00:00:00Z'));
		expect(late).toEqual({ text: 'due Jan 2', late: true });
		expect(dueLabel(null)).toBeNull();
	});

	test('why a queued task waits', () => {
		expect(queueStatus({ status: 'running' })).toBeNull();
		expect(queueStatus({ status: 'queued', hold: true })?.label).toBe('on hold');
		expect(queueStatus({ status: 'queued', queue: 'worker' })?.label).toBe('waits for worker');
		expect(queueStatus({ status: 'queued', queue: 'slot' })?.label).toBe('waiting for a slot');
		expect(queueStatus({ status: 'queued', queue: 'starting' })?.label).toBe('starting');
		expect(queueStatus({ status: 'queued' })?.label).toBe('queued');
	});
});
