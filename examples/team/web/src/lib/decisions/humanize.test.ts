import { describe, expect, test } from 'bun:test';
import type { UIMessage } from 'ai';
import { approvalChip } from '../approval/chip';
import { isInstructionMessage, viewModel } from '../parts/map';
import { describeScheduleWords } from '../routines/schedule';
import { queueStatus } from '../tasks/queue';
import { cleanBody, mayTouchLines, standDownOptions, toolWords, type Decision, willNotTouchLines } from './model';

describe('plan card words', () => {
	test('a schedule in words with the zone, never raw cron', () => {
		expect(describeScheduleWords({ kind: 'cron', expr: '0 9 * * 1-5', tz: 'UTC' })).toBe('Every weekday at 09:00 UTC');
		expect(describeScheduleWords({ kind: 'cron', expr: '30 17 * * 5', tz: 'UTC' })).toBe('Every Friday at 17:30 UTC');
		expect(describeScheduleWords({ kind: 'cron', expr: '0 8 1 * *', tz: 'UTC' })).toBe('On day 1 of every month at 08:00 UTC');
		expect(describeScheduleWords({ kind: 'cron', expr: '0 */2 * * *', tz: 'UTC' })).toBe('Every 2 hours');
		expect(describeScheduleWords({ kind: 'cron', expr: '5 4 1 2 *', tz: 'UTC' })).toContain('custom schedule');
	});

	test('"may touch" and "will not touch" without tool ids', () => {
		expect(toolWords('read_file')).toBe('read files');
		expect(toolWords('tracker__list_issues')).toBe('list issues (tracker)');
		const lines = mayTouchLines({ tools: ['web_fetch'], connectors: ['github'], read: ['/library/in/**'], write: ['/library/out/**'] } as never);
		expect(lines).toEqual(['Can open web pages', 'Can use the github connection', 'Can read everything under /library/in', 'Can read and change everything under /library/out']);
		expect(willNotTouchLines({ program: { forbidden: ['run_code', 'Never email customers'] } } as never)).toEqual(['Will not run code', 'Never email customers']);
		expect(willNotTouchLines({ program: { forbidden: ['Bash(rm *)', 'Edit(/library/final/**)', 'WebFetch(domain:example.com)', 'Bash(git push:*)'] } } as never)).toEqual([
			'Will not delete files with rm',
			'Will not edit everything under /library/final',
			'Will not open pages on example.com',
			'Will not run `git push` commands'
		]);
	});

	test('no pointer to the Decision Center inside it', () => {
		expect(cleanBody('Check stock.\nApprove or edit it in the Decision Center.')).toBe('Check stock.');
		expect(cleanBody('Plain.')).toBe('Plain.');
	});
});

describe('server markers', () => {
	test('the instruction flag decides; the position is only the fallback for old messages', () => {
		const flagged = { id: 'a', role: 'user', parts: [], metadata: { app: { instruction: true } } } as unknown as UIMessage;
		const plain = { id: 'b', role: 'user', parts: [] } as unknown as UIMessage;
		const notIt = { id: 'c', role: 'user', parts: [], metadata: { app: { instruction: false } } } as unknown as UIMessage;
		expect(isInstructionMessage(flagged)).toBe(true);
		expect(isInstructionMessage(plain)).toBe(false);
		expect(isInstructionMessage(plain, true)).toBe(true);
		expect(isInstructionMessage(notIt, true)).toBe(false);
	});

	test('auto-allowed comes from the message metadata, not from reason text', () => {
		const msg = {
			id: 'm',
			role: 'assistant',
			metadata: { app: { autoAllowed: { c1: 'rule' } } },
			parts: [{ type: 'tool-read_file', toolCallId: 'c1', state: 'output-available', input: {}, output: 'x', approval: { id: 'a1', approved: true, reason: 'because' } }]
		} as unknown as UIMessage;
		const view = viewModel(msg)[0] as unknown;
		expect(approvalChip(view as never)).toEqual({ kind: 'approved', text: 'Auto-allowed' });
		expect(approvalChip({ state: 'output-available', approval: { id: 'a', approved: true, reason: 'auto rule allow' } })).toEqual({ kind: 'approved', text: 'Approved' });
	});

	test('stand-down options come from the payload', () => {
		const d = { kind: 'escalation', payload: { question: 'q', options: ['A', 'B'], standDown: ['B'], source: 'agent' } } as unknown as Decision;
		expect(standDownOptions(d)).toEqual(['B']);
		expect(standDownOptions({ kind: 'escalation', payload: { question: 'q', options: ['A'], source: 'agent' } } as unknown as Decision)).toEqual([]);
	});

	test('the queue note rides along the slot label', () => {
		const q = queueStatus({ status: 'queued', queue: 'slot', queueNote: 'waiting: Draft needs your approval first' });
		expect(q?.note).toBe('waiting: Draft needs your approval first');
		expect(q?.detail).toContain('needs your approval first');
		expect(queueStatus({ status: 'queued', queue: 'worker', queueNote: 'x' })?.note).toBeNull();
	});
});
