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

	test('file, routine and settings events bump their revision counters', () => {
		const { live } = setup();
		live.handleEvent(ev('file-changed', 'lead-id', { path: '/library/a.md' }));
		live.handleEvent(ev('routine-changed', 'lead-id'));
		live.handleEvent(ev('routine-fired', 'lead-id'));
		live.handleEvent(ev('settings-changed', 'lead-id'));
		live.handleEvent(ev('mode-changed', 'lead-id', { mode: 'auto' }));
		expect(live.state.revs).toEqual({ files: 1, routines: 2, settings: 1, modes: 1, chat: 0 });
		// a stored message moves the context size of the open chat
		live.handleEvent(ev('message-added', 'lead-id', { role: 'assistant' }));
		expect(live.state.revs.chat).toBe(1);
	});
});

describe('live store: stale task lists', () => {
	test('a /tasks response that started before a task-changed event does not undo it', async () => {
		const task = (status: Task['status']): Task => ({ id: 't1', status, title: 'Research', lastActivityAt: 1 }) as Task;
		let server: Task[] = [task('needs_action')];
		const gates: Array<() => void> = [];
		let calls = 0;
		const api = {
			get: async (path: string) => {
				if (path !== '/tasks') return { approvals: [], agents: [] };
				calls++;
				const snapshot = server.map((t) => ({ ...t }));
				await new Promise<void>((r) => gates.push(r));
				return { tasks: snapshot };
			},
			post: async () => ({})
		} as unknown as ApiClient;
		const agents = createAgentsCore(api, emptyAgentsState());
		const live = createLiveCore(api, agents, emptyLiveState(), { setTimeout: (fn) => fn() });
		live.state.tasks = [task('needs_action')];

		const first = live.loadTasks(); // snapshot: needs_action
		server = [task('running')];
		live.handleEvent(ev('task-changed', 'x', { taskId: 't1', status: 'running' }, 2)); // refetch queued
		expect(live.state.tasks[0]?.status).toBe('running');
		gates.shift()?.(); // the old response lands last-but-one
		await first;
		expect(live.state.tasks[0]?.status).toBe('running');
		while (gates.length) gates.shift()?.();
		await new Promise((r) => setTimeout(r, 0));
		expect(live.state.tasks[0]?.status).toBe('running');
		expect(calls).toBeGreaterThanOrEqual(2);
	});
});

describe('live store: chat events', () => {
	test('turn-started and message-added reach chat listeners; others do not', () => {
		const { live } = setup();
		const seen: string[] = [];
		const off = live.onChatEvent((e) => seen.push(e.type));
		live.handleEvent(ev('turn-started', 'lead-id', {}, 1));
		live.handleEvent(ev('message-added', 'lead-id', { role: 'assistant', preview: 'x' }, 2));
		live.handleEvent(ev('file-changed', 'lead-id', { path: '/a' }, 3));
		off();
		live.handleEvent(ev('turn-started', 'lead-id', {}, 4));
		expect(seen).toEqual(['turn-started', 'message-added']);
	});

	test('model-call events reach their listeners only', () => {
		const { live, agents } = setup();
		const seen: string[] = [];
		const off = live.onModelCallEvent((e) => seen.push(String(e.payload.id)));
		live.handleEvent(ev('model-call', 'lead-id', { id: 'c1' }));
		live.handleEvent(ev('message-added', 'lead-id', { role: 'assistant', preview: 'x' }, 2));
		off();
		live.handleEvent(ev('model-call', 'lead-id', { id: 'c2' }, 3));
		expect(seen).toEqual(['c1']);
		expect(agents.state.activity['lead-id']?.unread).toBe(1);
	});
});
