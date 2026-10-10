import { describe, expect, test } from 'bun:test';
import type { Approval, ApiClient, Task } from '../api/client';
import type { TeamEvent } from '../events/client';
import { createAgentsCore, emptyAgentsState } from './agents-core';
import { createLiveCore, emptyLiveState } from './live-core';

const ev = (type: string, agentId: string, payload: Record<string, unknown> = {}, seq = 1): TeamEvent => ({
	seq, type, agentId, sessionId: null, payload, createdAt: 1000 + seq
});

function setup(visible = true) {
	const posts: string[] = [];
	let approvals: Approval[] = [];
	const api = {
		get: async (path: string) => {
			if (path === '/approvals') return { approvals };
			if (path === '/tasks') return { tasks: [] as Task[] };
			if (path === '/agents') return { agents: [] };
			throw new Error(path);
		},
		post: async (path: string, o?: { params?: { id: string } }) => {
			posts.push(`${path}:${o?.params?.id}`);
			return {};
		}
	} as unknown as ApiClient;
	const agents = createAgentsCore(api, emptyAgentsState());
	agents.state.agents = [{ id: 'lead-id', slug: 'lead', name: 'Lead' } as never];
	agents.state.activity['lead-id'] = { preview: null, lastMessageAt: null, unread: 0 };
	const live = createLiveCore(api, agents, emptyLiveState(), { isVisible: () => visible, setTimeout: (fn) => fn() });
	return { live, agents, posts, setApprovals: (a: Approval[]) => (approvals = a) };
}

const appr = (id: string, parent: string | null): Approval =>
	({ id, kind: 'approval', sessionId: `s-${id}`, parentSessionId: parent, agentId: 'x', agentName: 'Researcher', taskId: 't', toolName: 'web_fetch' }) as Approval;

describe('live store', () => {
	test('message-added updates preview/time and counts unread when not viewing', () => {
		const { live, agents } = setup();
		live.handleEvent(ev('message-added', 'lead-id', { role: 'assistant', preview: 'hi' }));
		expect(agents.state.activity['lead-id']).toEqual({ preview: 'hi', lastMessageAt: 1001, unread: 1 });
		live.handleEvent(ev('message-added', 'lead-id', { role: 'user', preview: 'yo' }, 2));
		expect(agents.state.activity['lead-id']?.unread).toBe(1);
	});

	test('viewing the chat keeps it read and posts the marker', async () => {
		const { live, agents, posts } = setup();
		live.state.viewing = 'lead'; // a slug resolves to the id
		live.handleEvent(ev('message-added', 'lead-id', { role: 'assistant', preview: 'hi' }));
		await Promise.resolve();
		expect(agents.state.activity['lead-id']?.unread).toBe(0);
		expect(posts).toEqual(['/agents/{id}/read:lead-id']);
	});

	test('a hidden tab does not mark read', () => {
		const { live, agents } = setup(false);
		live.state.viewing = 'lead';
		live.handleEvent(ev('message-added', 'lead-id', { role: 'assistant', preview: 'hi' }));
		expect(agents.state.activity['lead-id']?.unread).toBe(1);
	});

	test('answer removes optimistically, restores on failure, hints for child approvals', async () => {
		const { live, setApprovals } = setup();
		const a = appr('1', 'dm:lead-id');
		setApprovals([a, appr('2', null)]);
		await live.loadApprovals();
		expect(live.childApprovals('lead').map((x) => x.id)).toEqual(['1']);
		setApprovals([appr('2', null)]); // the server no longer lists it after the answer
		await live.answer(a, { approved: true });
		expect(live.state.approvals.some((x) => x.id === '1')).toBe(false);
	});
});
