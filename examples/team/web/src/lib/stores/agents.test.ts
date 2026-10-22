import { describe, expect, test } from 'bun:test';
import { ApiError, type Agent, type ApiClient } from '../api/client';
import { createAgentsCore, emptyAgentsState } from './agents-core';

const agent = (id: string, over: Partial<Agent> = {}): Agent =>
	({ id, slug: id, name: id, role: 'custom', tools: [], version: 1, ...over }) as unknown as Agent;

function fake(handlers: Record<string, (o?: { body?: unknown }) => unknown>): ApiClient {
	const call = (m: string) => async (path: string, o?: { body?: unknown }) => {
		const h = handlers[`${m} ${path}`];
		if (!h) throw new Error(`unexpected ${m} ${path}`);
		return h(o);
	};
	return { get: call('get'), post: call('post'), patch: call('patch'), delete: call('delete') } as unknown as ApiClient;
}

describe('agents core', () => {
	test('load, create, update, archive', async () => {
		const api = fake({
			'get /agents': () => ({ agents: [agent('a'), agent('b')] }),
			'post /agents': (o) => agent('c', o?.body as Partial<Agent>),
			'patch /agents/{id}': (o) => agent('a', { ...(o?.body as Partial<Agent>), version: 2 }),
			'delete /agents/{id}': () => agent('b')
		});
		const s = createAgentsCore(api, emptyAgentsState());
		await s.load();
		expect(s.state.agents.map((a) => a.id)).toEqual(['a', 'b']);
		await s.create({ name: 'C', instructions: 'x' });
		expect(s.find('c')?.name).toBe('C');
		await s.update('a', { name: 'A2' });
		expect(s.find('a')).toMatchObject({ name: 'A2', version: 2 });
		await s.archive('b');
		expect(s.find('b')).toBeUndefined();
	});

	test('an archived agent fetched by id for its name never joins the picker list', async () => {
		const api = fake({
			'get /agents': () => ({ agents: [agent('a')] }),
			'get /agents/{id}': () => agent('old', { archivedAt: 5 } as Partial<Agent>)
		});
		const s = createAgentsCore(api, emptyAgentsState());
		await s.load();
		expect((await s.get('old')).id).toBe('old');
		expect(s.state.agents.map((a) => a.id)).toEqual(['a']);
	});

	test('failed update and archive roll back', async () => {
		const fail = () => {
			throw new ApiError(409, 'CONFLICT', 'nope');
		};
		const api = fake({
			'get /agents': () => ({ agents: [agent('a', { name: 'orig' }), agent('b')] }),
			'patch /agents/{id}': fail,
			'delete /agents/{id}': fail
		});
		const s = createAgentsCore(api, emptyAgentsState());
		await s.load();
		await expect(s.update('a', { name: 'x' })).rejects.toBeInstanceOf(ApiError);
		expect(s.find('a')?.name).toBe('orig');
		await expect(s.archive('a')).rejects.toBeInstanceOf(ApiError);
		expect(s.state.agents.map((a) => a.id)).toEqual(['a', 'b']);
	});

	test('load error is kept in state', async () => {
		const s = createAgentsCore(fake({ 'get /agents': () => { throw new ApiError(0, 'NETWORK_ERROR', 'down'); } }), emptyAgentsState());
		await s.load();
		expect(s.state.error).toBe('down');
		expect(s.state.loaded).toBe(false);
	});
});
