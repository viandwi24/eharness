import { describe, expect, test } from 'bun:test';
import type { ApiClient, ModelCallSummary } from '../api/client';
import type { ActivityRecord } from 'eharness/client';
import { createLogsCore, emptyLogsState } from './core';
import { emptyFilters } from './logs';

const row = (id: string, startedAt: number): ModelCallSummary => ({ id, startedAt, kind: 'step', status: 'ok', modelId: 'm', provider: 'p', durationMs: 1 }) as ModelCallSummary;
const ev = (over: Partial<ActivityRecord['payload']> = {}, agentId = 'a1'): ActivityRecord => ({
	seq: 1, type: 'model-call', agentId, sessionId: 'dm:a1', payload: { id: 'x', kind: 'step', status: 'ok', model: 'm', ...over }, createdAt: 1
});

function setup(pages: Record<string, { items: ModelCallSummary[]; nextCursor: string | null }>) {
	const calls: Array<{ path: string; query: Record<string, unknown> }> = [];
	let head = pages[''] as { items: ModelCallSummary[]; nextCursor: string | null };
	const api = {
		get: async (path: string, o?: { query?: Record<string, unknown> }) => {
			calls.push({ path, query: o?.query ?? {} });
			if (path === '/logs') return pages[String(o?.query?.cursor ?? '')] === undefined ? head : (pages[String(o?.query?.cursor)] ?? head);
			if (path === '/logs/stats') return { from: 0, to: 1, bucketMs: 1, buckets: [], totals: { count: 0, errors: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, aborted: 0 }, models: [] };
			throw new Error(path);
		}
	} as unknown as ApiClient;
	const state = emptyLogsState();
	const core = createLogsCore(api, state, { now: () => 1_000_000, pageSize: 2, setTimeout: (fn) => fn() });
	return { core, state, calls, setHead: (h: typeof head) => (head = h) };
}

describe('logs core', () => {
	test('load fills the list and stats; loadMore appends without duplicates', async () => {
		const { core, state } = setup({ '': { items: [row('b', 20), row('a', 10)], nextCursor: 'c1' }, c1: { items: [row('a', 10), row('z', 5)], nextCursor: null } });
		await core.load(emptyFilters());
		expect(state.items.map((i) => i.id)).toEqual(['b', 'a']);
		expect(state.stats).not.toBeNull();
		await core.loadMore();
		expect(state.items.map((i) => i.id)).toEqual(['b', 'a', 'z']);
		expect(state.nextCursor).toBeNull();
	});

	test('a failed load shows the error', async () => {
		const state = emptyLogsState();
		const api = { get: async () => { throw new Error('boom'); } } as unknown as ApiClient;
		await createLogsCore(api, state).load(emptyFilters());
		expect(state.error).toBe('boom');
		expect(state.loading).toBe(false);
	});

	test('live: at the top rows are prepended, scrolled down they are counted, other views ignored', async () => {
		const t = setup({ '': { items: [row('b', 20), row('a', 10)], nextCursor: null } });
		await t.core.load({ ...emptyFilters(), agentId: 'a1' });
		t.setHead({ items: [row('c', 30), row('b', 20)], nextCursor: null });
		t.core.onEvent(ev(), true);
		await new Promise((r) => setTimeout(r, 0));
		expect(t.state.items.map((i) => i.id)).toEqual(['c', 'b', 'a']);
		t.core.onEvent(ev(), false);
		t.core.onEvent(ev(), false);
		expect(t.state.newCount).toBe(2);
		t.core.onEvent(ev({}, 'other'), false);
		t.core.onEvent({ ...ev(), type: 'task-changed' }, false);
		expect(t.state.newCount).toBe(2);
		await t.core.showNew();
		expect(t.state.newCount).toBe(0);
	});
});
