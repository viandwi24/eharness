/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import type { UIMessage } from 'ai';
import { mergeLive, pollDelay, taskIdOfSession, upsertMessage } from './follow.ts';

describe('polling decision', () => {
	test('polls only a running task that is not streaming', () => {
		expect(pollDelay({ status: 'running', streaming: false })).toBe(1000);
		expect(pollDelay({ status: 'running', streaming: true })).toBeNull();
		expect(pollDelay({ status: 'done', streaming: false })).toBeNull();
		expect(pollDelay({ status: 'needs_action', streaming: false })).toBeNull();
		expect(pollDelay({ status: 'running', streaming: false, visible: false })).toBe(5000);
	});
});

describe('id mapping and merging', () => {
	test('child session id maps to its task id', () => {
		const tasks = [{ id: 't1', sessionId: 's1' }, { id: 't2', sessionId: 's2' }];
		expect(taskIdOfSession(tasks, 's2')).toBe('t2');
		expect(taskIdOfSession(tasks, 'nope')).toBeUndefined();
	});
	test('upsert replaces by id or appends', () => {
		expect(upsertMessage([{ id: 'a', v: 1 }], { id: 'a', v: 2 })).toEqual([{ id: 'a', v: 2 }]);
		expect(upsertMessage([{ id: 'a', v: 1 }], { id: 'b', v: 2 }).map((m) => m.id)).toEqual(['a', 'b']);
	});
	test('live messages override stored ones by id', () => {
		const stored = [{ id: 'a', role: 'user', parts: [] }, { id: 'm1', role: 'assistant', parts: [] }] as UIMessage[];
		const live = new Map([['m1', { id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'x' }] } as UIMessage]]);
		const out = mergeLive(stored, live);
		expect(out).toHaveLength(2);
		expect(out[1]?.parts).toHaveLength(1);
	});
});
