import { describe, expect, test } from 'bun:test';
import type { ApiClient, Thread } from '../api/client';
import { createThreadsCore, emptyThreadsState } from './threads-core';

const thread = (id: string, over: Partial<Thread> = {}): Thread => ({
	id,
	agentId: 'a',
	sessionId: `chat:a:${id}`,
	title: null,
	source: 'web',
	sourceLabel: null,
	seed: null,
	createdAt: 1,
	updatedAt: 1,
	lastMessageAt: null,
	preview: null,
	archivedAt: null,
	...over
});

describe('threads store', () => {
	test('load, create (newest first), rename, archive and restore update the list', async () => {
		const calls: string[] = [];
		const api = {
			get: async () => ({ threads: [thread('t1')] }),
			post: async (path: string, o: { params?: { threadId?: string }; body?: { title?: string } }) => {
				calls.push(path);
				if (path.endsWith('/archive')) return thread('t1', { archivedAt: 9 });
				if (path.endsWith('/restore')) return thread('t1');
				if (path === '/threads/discuss') return thread('t3', { title: 'Seeded', seed: { kind: 'alert', ref: 'n', title: 'Seeded' } });
				return thread('t2', { title: o.body?.title ?? null });
			},
			patch: async (_p: string, o: { body: { title: string } }) => thread('t1', { title: o.body.title })
		} as unknown as ApiClient;
		const core = createThreadsCore(api, emptyThreadsState());
		await core.load('a');
		expect(core.threadsOf('a').map((t) => t.id)).toEqual(['t1']);
		await core.create('a', 'Plan');
		expect(core.threadsOf('a').map((t) => t.id)).toEqual(['t2', 't1']);
		await core.rename('a', 't1', 'Renamed');
		expect(core.threadsOf('a').find((t) => t.id === 't1')?.title).toBe('Renamed');
		await core.archive('a', 't1');
		expect(core.threadsOf('a').find((t) => t.id === 't1')?.archivedAt).toBe(9);
		await core.restore('a', 't1');
		expect(core.threadsOf('a').find((t) => t.id === 't1')?.archivedAt).toBeNull();
		const seeded = await core.discuss({ kind: 'alert', ref: 'n' });
		expect(core.threadsOf('a')[0]?.id).toBe(seeded.id);
		expect(calls).toContain('/threads/discuss');
	});
	test('only the newest load writes', async () => {
		let release: (() => void) | undefined;
		let n = 0;
		const api = {
			get: async () => {
				const mine = ++n;
				if (mine === 1) await new Promise<void>((r) => (release = r));
				return { threads: [thread(mine === 1 ? 'old' : 'new')] };
			}
		} as unknown as ApiClient;
		const core = createThreadsCore(api, emptyThreadsState());
		const first = core.load('a');
		await core.load('a');
		release?.();
		await first;
		expect(core.threadsOf('a').map((t) => t.id)).toEqual(['new']);
	});
});
