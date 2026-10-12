import { describe, expect, test } from 'bun:test';
import type { Task } from '../api/client';
import { badgeFor, badgeOf, columnOf, groupBoard, queueOrder, upsertTask } from './board';

const t = (id: string, status: Task['status'], over: Partial<Task> = {}): Task =>
	({
		id,
		agentId: 'a',
		sessionId: `s:${id}`,
		status,
		title: id,
		lastActivityAt: 0,
		priority: 'normal',
		dueAt: null,
		createdBy: null,
		acceptedAt: null,
		report: null,
		summary: null,
		...over
	}) as Task;
const report = (status: 'done' | 'partial' | 'failed' | 'needs_decision') => ({ status, summary: 's', outputs: [] });

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
		expect(b.waiting.map((x) => x.id)).toEqual(['2']);
		expect(b.running.map((x) => x.id)).toEqual(['6', '1']);
		expect(b.done.map((x) => x.id)).toEqual(['4', '3', '5']);
		expect(b.queued).toEqual([]);
		expect(b.review).toEqual([]);
	});

	test('filters by agent', () => {
		const b = groupBoard(tasks, { agentId: 'b' });
		expect(b.done.map((x) => x.id)).toEqual(['5']);
		expect(b.running).toEqual([]);
	});

	test('badges and upsert', () => {
		expect(badgeFor('failed').variant).toBe('destructive');
		expect(badgeFor('stopped').label).toBe('stopped');
		expect(badgeFor('queued').label).toBe('queued');
		expect(upsertTask(tasks, t('2', 'running')).find((x) => x.id === '2')?.status).toBe('running');
		expect(upsertTask([], t('9', 'done')).length).toBe(1);
	});
});

describe('work queue columns', () => {
	test('a run parked on an open decision is waiting for you, not running', () => {
		const parked = t('p', 'running', { sessionId: 'program:x:1' });
		expect(columnOf(parked)).toBe('running');
		expect(columnOf(parked, new Set(['program:x:1']))).toBe('waiting');
		expect(badgeOf({ ...parked, summary: null }, new Set(['program:x:1'])).label).toBe('waiting for you');
	});

	test('review: a finished work item with a done or partial report that is not accepted', () => {
		const item = (over: Partial<Task>) => t('w', 'done', { createdBy: 'client', report: report('done'), ...over });
		expect(columnOf(item({}))).toBe('review');
		expect(columnOf(item({ report: report('partial') }))).toBe('review');
		expect(columnOf(item({ report: report('needs_decision') }))).toBe('done');
		expect(columnOf(item({ acceptedAt: 10 }))).toBe('done');
		expect(columnOf(item({ createdBy: null }))).toBe('done');
		// the creator did not ask for review (an agent that assigned the work reads it itself)
		expect(columnOf(item({ review: false }))).toBe('done');
		expect(columnOf(item({ review: true }))).toBe('review');
		expect(columnOf(item({ status: 'failed' }))).toBe('done');
		expect(badgeOf({ ...item({}), summary: null }).label).toBe('review');
		expect(badgeOf({ ...item({ acceptedAt: 10 }), summary: null }).label).toBe('accepted');
	});

	test('failing deliverables keep a work item out of Review (waiting while a decision is open)', () => {
		const fail = { status: 'fail' as const, attempts: 2, checkedAt: 1, checks: [] };
		const item = t('w', 'done', { createdBy: 'client', report: report('partial'), deliverables: fail, sessionId: 'program:x:1' });
		expect(columnOf(item)).toBe('done');
		expect(columnOf(item, new Set(['program:x:1']))).toBe('waiting');
		expect(columnOf({ ...item, deliverables: { ...fail, status: 'pass' } })).toBe('review');
	});

	test('a queued card says why it waits: hold, a slot, a worker program', () => {
		const q = (over: Partial<Task>) => ({ ...t('q', 'queued', over), summary: null });
		expect(badgeOf(q({ hold: true })).label).toBe('on hold');
		expect(badgeOf(q({ queue: 'hold' })).label).toBe('on hold');
		expect(badgeOf(q({ queue: 'slot' })).label).toBe('waiting for a slot');
		expect(badgeOf(q({ queue: 'worker' })).label).toBe('waits for worker');
		expect(badgeOf(q({ queue: 'starting' })).label).toBe('starting');
		expect(badgeOf(q({})).label).toBe('queued');
	});

	test('the queue is shown in the order a worker takes it', () => {
		const q = [
			t('old', 'queued'),
			t('urgent', 'queued', { priority: 'urgent' }),
			t('due', 'queued', { dueAt: 5 }),
			t('late', 'queued', { dueAt: 50 }),
			t('low', 'queued', { priority: 'low' })
		];
		expect([...q].sort(queueOrder).map((x) => x.id)).toEqual(['urgent', 'due', 'late', 'old', 'low']);
		expect(groupBoard(q).queued.map((x) => x.id)).toEqual(['urgent', 'due', 'late', 'old', 'low']);
	});
});
