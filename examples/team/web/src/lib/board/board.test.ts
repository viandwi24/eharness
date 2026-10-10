import { describe, expect, test } from 'bun:test';
import type { Task } from '../api/client';
import { badgeFor, groupBoard, upsertTask } from './board';

const t = (id: string, status: Task['status'], over: Partial<Task> = {}): Task =>
	({ id, agentId: 'a', sessionId: `s:${id}`, status, title: id, lastActivityAt: 0, ...over }) as Task;

describe('board', () => {
	const tasks = [
		t('1', 'running', { lastActivityAt: 1 }),
		t('2', 'needs_action'),
		t('3', 'done', { lastActivityAt: 5 }),
		t('4', 'failed', { lastActivityAt: 9 }),
		t('5', 'stopped', { agentId: 'b' }),
		t('6', 'running', { lastActivityAt: 3 })
	];

	test('groups columns, failed and stopped land in done, newest first', () => {
		const b = groupBoard(tasks);
		expect(b.needs.map((x) => x.id)).toEqual(['2']);
		expect(b.running.map((x) => x.id)).toEqual(['6', '1']);
		expect(b.done.map((x) => x.id)).toEqual(['4', '3', '5']);
	});

	test('filters by agent', () => {
		const b = groupBoard(tasks, { agentId: 'b' });
		expect(b.done.map((x) => x.id)).toEqual(['5']);
		expect(b.running).toEqual([]);
	});

	test('badges and upsert', () => {
		expect(badgeFor('failed').variant).toBe('destructive');
		expect(badgeFor('stopped').label).toBe('stopped');
		expect(upsertTask(tasks, t('2', 'running')).find((x) => x.id === '2')?.status).toBe('running');
		expect(upsertTask([], t('9', 'done')).length).toBe(1);
	});
});
