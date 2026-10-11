/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { byNewest, groupItems, notificationLink, pickBriefing } from './model.ts';

const item = (kind: 'run' | 'decision' | 'waiting' | 'noticed' | 'cost', title: string) => ({ kind, title, detail: '', link: null });

describe('briefing model', () => {
	test('items are grouped in reading order and keep their index for "Discuss in chat"', () => {
		const groups = groupItems([item('noticed', 'n'), item('run', 'r'), item('waiting', 'w'), item('run', 'r2')]);
		expect(groups.map((g) => g.kind)).toEqual(['run', 'waiting', 'noticed']);
		expect(groups[0]?.items.map((x) => x.index)).toEqual([1, 3]);
	});
	test('pick: by id, else the newest', () => {
		const list = [{ id: 'b' }, { id: 'a' }] as never[];
		expect(pickBriefing(list, 'a')).toEqual({ id: 'a' } as never);
		expect(pickBriefing(list, 'x')).toEqual({ id: 'b' } as never);
	});
	test('notification links are app paths only', () => {
		expect(notificationLink({ link: '/tasks/1' })).toBe('/tasks/1');
		expect(notificationLink({ link: 'https://x' })).toBeNull();
		expect(notificationLink({ link: null })).toBeNull();
	});
	test('newest first', () => {
		expect(byNewest([{ createdAt: 1 }, { createdAt: 3 }, { createdAt: 2 }]).map((x) => x.createdAt)).toEqual([3, 2, 1]);
	});
});
