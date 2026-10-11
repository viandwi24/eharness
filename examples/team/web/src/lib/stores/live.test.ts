import { describe, expect, test } from 'bun:test';
import { type ActivityRecord, type HarnessClient, HarnessHttpError } from 'eharness/client';
import type { Approval, ApiClient, Task } from '../api/client';
import { createAgentsCore, emptyAgentsState } from './agents-core';
import { createLiveCore, emptyLiveState } from './live-core';

const ev = (type: string, agentId: string, payload: Record<string, unknown> = {}, seq = 1): ActivityRecord => ({
	seq, type, agentId, sessionId: null, payload, createdAt: 1000 + seq
});

type Answered = { id: string; sessionId: string; answer: unknown };
/** The `eharness/http` client: only the attention answer is used by the live store. */
const clientOf = (answer: (id: string, body: Answered) => Promise<unknown> = async () => ({ status: 'recorded' })): HarnessClient =>
	({ attention: { list: async () => ({ items: [] }), answer: (id: string, body: { sessionId: string; answer: unknown }) => answer(id, { id, ...body }) } }) as unknown as HarnessClient;

function setup(visible = true) {
	const posts: string[] = [];
	const answers: Answered[] = [];
	let approvals: Approval[] = [];
	let decisions: unknown[] = [];
	let notifications: unknown[] = [];
	const api = {
		get: async (path: string) => {
			if (path === '/approvals') return { approvals };
			if (path === '/tasks') return { tasks: [] as Task[] };
			if (path === '/decisions') return { decisions: decisions, open: decisions.length };
			if (path === '/agents') return { agents: [] };
			if (path === '/notifications') return { notifications, open: notifications.length };
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
	const client = clientOf(async (_id, body) => (answers.push(body), { status: 'recorded' }));
	const live = createLiveCore(api, agents, emptyLiveState(), { client, isVisible: () => visible, setTimeout: (fn) => fn() });
	return { live, agents, posts, answers, setApprovals: (a: Approval[]) => (approvals = a), setDecisions: (d: unknown[]) => (decisions = d), setNotifications: (n: unknown[]) => (notifications = n) };
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
		const { live, setApprovals, answers } = setup();
		const a = appr('1', 'dm:lead-id');
		setApprovals([a, appr('2', null)]);
		await live.loadApprovals();
		expect(live.childApprovals('lead').map((x) => x.id)).toEqual(['1']);
		setApprovals([appr('2', null)]); // the server no longer lists it after the answer
		await live.answer(a, { approved: true, remember: 'session' });
		expect(live.state.approvals.some((x) => x.id === '1')).toBe(false);
		// the wire answer carries the kind and the session of the item
		expect(answers).toEqual([{ id: '1', sessionId: 's-1', answer: { kind: 'approval', approved: true, remember: 'session' } }]);
		await live.answer(appr('3', null), { answers: [{ selected: ['A'] }] });
		expect(answers[1]?.answer).toEqual({ kind: 'question', answers: [{ selected: ['A'] }] });
	});

	test('file, routine and settings events bump their revision counters', () => {
		const { live } = setup();
		live.handleEvent(ev('file-changed', 'lead-id', { path: '/library/a.md' }));
		live.handleEvent(ev('routine-changed', 'lead-id'));
		live.handleEvent(ev('routine-fired', 'lead-id'));
		live.handleEvent(ev('program-changed', 'lead-id', { programId: 'p1', change: 'paused' }));
		live.handleEvent(ev('settings-changed', 'lead-id'));
		live.handleEvent(ev('heartbeat-changed', 'lead-id', { change: 'beat' }));
		live.handleEvent(ev('mode-changed', 'lead-id', { mode: 'auto' }));
		live.handleEvent(ev('providers-changed', 'lead-id', { profileId: 'openrouter', action: 'put' }));
		live.handleEvent(ev('connectors-changed', 'lead-id', { instance: 'x' }));
		expect(live.state.revs).toEqual({ files: 1, routines: 2, programs: 1, heartbeat: 1, decisions: 0, settings: 1, modes: 1, chat: 0, providers: 1, connectors: 1, threads: 0, briefings: 0 });
		// a stored message moves the context size of the open chat
		live.handleEvent(ev('message-added', 'lead-id', { role: 'assistant' }));
		expect(live.state.revs.chat).toBe(1);
	});
});

describe('live store: decisions', () => {
	test('a decision-changed event refetches the open decisions and moves the page revision', async () => {
		const { live, setDecisions } = setup();
		expect(live.state.decisions).toEqual([]);
		setDecisions([{ id: 'd1', kind: 'proposal', status: 'open', title: 'Plan' }]);
		live.handleEvent(ev('decision-changed', 'lead-id', { decisionId: 'd1', change: 'created', open: 1 }));
		await new Promise((r) => setTimeout(r, 0));
		expect(live.state.decisions.map((d) => d.id)).toEqual(['d1']);
		expect(live.state.decisionsLoaded).toBe(true);
		expect(live.state.revs.decisions).toBe(1);
		// decided elsewhere: it leaves the list
		setDecisions([]);
		live.handleEvent(ev('decision-changed', 'lead-id', { decisionId: 'd1', change: 'decided', open: 0 }, 2));
		await new Promise((r) => setTimeout(r, 0));
		expect(live.state.decisions).toEqual([]);
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
		const live = createLiveCore(api, agents, emptyLiveState(), { client: clientOf(), setTimeout: (fn) => fn() });
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

describe('live store: approvals that were decided elsewhere', () => {
	test('pending-changed (the library feed event) refetches the approvals', async () => {
		const { live, setApprovals } = setup();
		setApprovals([]);
		await live.loadApprovals();
		expect(live.state.approvals).toEqual([]);
		setApprovals([appr('1', 'dm:lead-id')]);
		live.handleEvent({ ...ev('pending-changed', 'x', { waiting: [{ kind: 'approval', id: '1', toolName: 'pay' }], answered: [] }, 4), sessionId: 's-1' });
		await new Promise((r) => setTimeout(r, 0));
		expect(live.state.approvals.map((a) => a.id)).toEqual(['1']);
	});

	test('approval-decided removes the card at once (Auto classifier, another tab), others stay', async () => {
		const { live, setApprovals } = setup();
		setApprovals([appr('1', 'dm:lead-id'), appr('2', null)]);
		await live.loadApprovals();
		live.handleEvent({ ...ev('approval-decided', 'x', { id: '1', approved: true, by: 'user' }, 5), sessionId: 's-1' });
		expect(live.state.approvals.map((a) => a.id)).toEqual(['2']);
		// an event of another session with the same id does not remove it
		live.handleEvent({ ...ev('approval-decided', 'x', { id: '2' }, 6), sessionId: 'other' });
		expect(live.state.approvals.map((a) => a.id)).toEqual(['2']);
		// a decision without an id (the classifier) leaves the list to the refetch
		live.handleEvent(ev('approval-decided', 'x', { toolName: 'web_search', by: 'plugin:permissions' }, 7));
		expect(live.state.approvals.map((a) => a.id)).toEqual(['2']);
	});

	test('answering an item that is already answered keeps it gone and refetches; other failures put it back', async () => {
		let fail: Error = new HarnessHttpError(404, 'EH_HTTP_NOT_FOUND', 'gone');
		let server: Approval[] = [];
		const api = {
			get: async (path: string) => (path === '/approvals' ? { approvals: server } : path === '/tasks' ? { tasks: [] } : { agents: [] }),
			post: async () => ({})
		} as unknown as ApiClient;
		const client = clientOf(async () => {
			throw fail;
		});
		const agents = createAgentsCore(api, emptyAgentsState());
		const live = createLiveCore(api, agents, emptyLiveState(), { client, setTimeout: (fn) => fn() });
		const a = appr('1', null);
		server = [a, appr('2', null)];
		await live.loadApprovals();
		server = [appr('2', null)]; // answered elsewhere: the server no longer lists it
		await expect(live.answer(a, { approved: true })).rejects.toBe(fail);
		expect(live.state.approvals.map((x) => x.id)).toEqual(['2']);

		server = [];
		fail = new HarnessHttpError(409, 'EH_HTTP_ALREADY_ANSWERED', 'x');
		server = [a];
		await live.loadApprovals();
		server = [];
		await expect(live.answer(a, { approved: true })).rejects.toBe(fail);
		expect(live.state.approvals).toEqual([]);

		// a real failure: the card returns (the refetch below then shows the server's truth)
		fail = new HarnessHttpError(500, 'INTERNAL', 'boom');
		server = [a];
		await live.loadApprovals();
		expect(live.state.approvals.map((x) => x.id)).toEqual(['1']);
		await expect(live.answer(a, { approved: true })).rejects.toBe(fail);
		expect(live.state.approvals.map((x) => x.id)).toEqual(['1']);
	});
});

describe('live store: inline answers stay in their own session', () => {
	test('ownApproval finds only approvals of the agent\'s own DM, never a child\'s', async () => {
		const { live, setApprovals } = setup();
		const own = { ...appr('own', null), sessionId: 'dm:lead-id' } as Approval;
		const child = { ...appr('child', 'dm:lead-id'), sessionId: 'dm:lead-id:agent:call-1' } as Approval;
		const question = { ...appr('q', null), sessionId: 'dm:lead-id', kind: 'question' } as Approval;
		setApprovals([own, child, question]);
		await live.loadApprovals();
		expect(live.ownApproval('lead', 'own')?.id).toBe('own');
		expect(live.ownApproval('lead-id', 'own')?.id).toBe('own');
		expect(live.ownApproval('lead', 'child')).toBeUndefined();
		expect(live.ownApproval('lead', 'q')).toBeUndefined();
		// decided: gone from the list, so the inline card is not offered any more
		live.handleEvent({ ...ev('approval-decided', 'lead-id', { id: 'own' }, 9), sessionId: 'dm:lead-id' });
		expect(live.ownApproval('lead', 'own')).toBeUndefined();
	});
});

describe('live store: threads and the bell', () => {
	test('inline items follow the thread: own questions and children of that thread only', async () => {
		const { live, setApprovals } = setup();
		const q1 = { ...appr('q1', null), sessionId: 'chat:lead-id:t1', kind: 'question' } as Approval;
		const q2 = { ...appr('q2', null), sessionId: 'chat:lead-id:t2', kind: 'question' } as Approval;
		const c1 = { ...appr('c1', 'chat:lead-id:t1'), sessionId: 'chat:lead-id:t1:agent:x' } as Approval;
		const c2 = { ...appr('c2', 'chat:lead-id:t2'), sessionId: 'chat:lead-id:t2:agent:x' } as Approval;
		setApprovals([q1, q2, c1, c2]);
		await live.loadApprovals();
		expect(live.chatPending('lead', 'chat:lead-id:t1').map((a) => a.id)).toEqual(['q1', 'c1']);
		expect(live.chatPending('lead', 'chat:lead-id:t2').map((a) => a.id)).toEqual(['q2', 'c2']);
		// without a thread: everything of the agent
		expect(live.chatPending('lead').map((a) => a.id).sort()).toEqual(['c1', 'c2', 'q1', 'q2']);
		const own = { ...appr('own', null), sessionId: 'chat:lead-id:t1' } as Approval;
		setApprovals([own]);
		await live.loadApprovals();
		expect(live.ownApproval('lead', 'own', 'chat:lead-id:t1')?.id).toBe('own');
		expect(live.ownApproval('lead', 'own', 'chat:lead-id:t2')).toBeUndefined();
	});

	test('notification and briefing events refetch the bell; thread events bump the list revision', async () => {
		const { live, setNotifications } = setup();
		setNotifications([{ id: 'n1', kind: 'alert', title: 'Budget', body: '', link: null, agentId: null, createdAt: 1, dismissedAt: null }]);
		live.handleEvent(ev('notification-changed', 'lead-id'));
		await Promise.resolve();
		await Promise.resolve();
		expect(live.state.notifications.map((n) => n.id)).toEqual(['n1']);
		const before = live.state.revs.threads;
		live.handleEvent(ev('thread-changed', 'lead-id'));
		await Promise.resolve();
		expect(live.state.revs.threads).toBe(before + 1);
		const briefings = live.state.revs.briefings;
		live.handleEvent(ev('briefing-added', 'lead-id'));
		await Promise.resolve();
		expect(live.state.revs.briefings).toBe(briefings + 1);
	});
});
