import type { Approval, ApiClient, ApprovalBody, Task } from '../api/client';
import { upsertTask } from '../board/board';
import type { Connection, TeamEvent } from '../events/client';
import { applyActivity } from './activity';
import type { AgentsStore } from './agents-core';

export type LiveState = {
	approvals: Approval[];
	approvalsLoaded: boolean;
	tasks: Task[];
	tasksLoaded: boolean;
	connection: Connection;
	/** Agent id (or slug) of the open chat; null elsewhere. */
	viewing: string | null;
	/** Counters bumped (debounced) by file / routine / settings / mode / message events; screens refetch when one moves. */
	revs: { files: number; routines: number; settings: number; modes: number; chat: number; providers: number };
};

export const emptyLiveState = (): LiveState => ({
	approvals: [],
	approvalsLoaded: false,
	tasks: [],
	tasksLoaded: false,
	connection: 'idle',
	viewing: null,
	revs: { files: 0, routines: 0, settings: 0, modes: 0, chat: 0, providers: 0 }
});

export type LiveDeps = {
	isVisible?: () => boolean;
	/** Debounce for refetches triggered by events (ms). */
	debounceMs?: number;
	setTimeout?: (fn: () => void, ms: number) => unknown;
	onError?: (e: unknown) => void;
};

/** Live store logic: approvals inbox, task board and sidebar activity, driven by the events feed. */
export function createLiveCore(api: ApiClient, agents: AgentsStore, state: LiveState, deps: LiveDeps = {}) {
	const visible = deps.isVisible ?? (() => true);
	const debounce = deps.debounceMs ?? 250;
	const timer = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
	const pending = new Set<string>();
	const report = (e: unknown): void => deps.onError?.(e);

	function later(key: string, fn: () => Promise<void>): void {
		if (pending.has(key)) return;
		pending.add(key);
		timer(() => {
			pending.delete(key);
			void fn();
		}, debounce);
	}

	const viewingId = (): string | null => {
		if (!state.viewing || !visible()) return null;
		return agents.find(state.viewing)?.id ?? state.viewing;
	};

	// A list fetched while a newer event arrived is stale: it must not overwrite what that event
	// applied. `gen` counts events per list; a fetch that saw a later event refetches, and only the
	// newest request may write.
	const gen = { tasks: 0, approvals: 0 };
	const req = { tasks: 0, approvals: 0 };
	async function fetchList<K extends 'tasks' | 'approvals'>(key: K, load: () => Promise<LiveState[K]>, done: () => void): Promise<void> {
		const atGen = gen[key];
		const mine = ++req[key];
		try {
			const list = await load();
			if (mine !== req[key]) return; // a newer request writes
			state[key] = list;
			done();
			if (atGen !== gen[key]) later(key, key === 'tasks' ? core.loadTasks : core.loadApprovals);
		} catch (e) {
			report(e);
		}
	}

	const bump = (k: keyof LiveState['revs']) => async (): Promise<void> => {
		state.revs[k]++;
	};

	const chatListeners = new Set<(e: TeamEvent) => void>();
	const modelCallListeners = new Set<(e: TeamEvent) => void>();

	const core = {
		state,

		/** Chat activity of DM sessions (`turn-started`, `message-added`): open chats follow server turns. */
		onChatEvent(fn: (e: TeamEvent) => void): () => void {
			chatListeners.add(fn);
			return () => chatListeners.delete(fn);
		},

		/** `model-call` events (one per logged provider call): the Logs page prepends rows. */
		onModelCallEvent(fn: (e: TeamEvent) => void): () => void {
			modelCallListeners.add(fn);
			return () => modelCallListeners.delete(fn);
		},

		loadApprovals(): Promise<void> {
			return fetchList('approvals', async () => (await api.get('/approvals')).approvals, () => (state.approvalsLoaded = true));
		},

		loadTasks(): Promise<void> {
			return fetchList('tasks', async () => (await api.get('/tasks', { query: { limit: 200 } })).tasks, () => (state.tasksLoaded = true));
		},

		async resync(): Promise<void> {
			await Promise.all([core.loadApprovals(), core.loadTasks(), agents.load()]);
		},

		handleEvent(e: TeamEvent): void {
			if (e.type === 'model-call') {
				for (const fn of modelCallListeners) {
					try {
						fn(e);
					} catch (error) {
						report(error);
					}
				}
				return; // nothing else reads it
			}
			if (e.type === 'turn-started' || e.type === 'message-added') {
				for (const fn of chatListeners) {
					try {
						fn(e);
					} catch (error) {
						report(error);
					}
				}
			}
			const effect = applyActivity(agents.state.activity, e, viewingId());
			if (effect.markRead) void core.markRead(effect.markRead, true);
			const p = e.payload;
			// a stored message (turn step or end): context size and usage of the open chat moved
			if (e.type === 'message-added') later('chat', bump('chat'));
			if (e.type === 'task-changed' || e.type === 'approval-needed' || e.type === 'approval-decided') {
				gen.tasks++;
				gen.approvals++;
			}
			if (e.type === 'task-changed') {
				const id = typeof p.taskId === 'string' ? p.taskId : undefined;
				const known = id ? state.tasks.find((t) => t.id === id) : undefined;
				if (known) {
					state.tasks = upsertTask(state.tasks, {
						...known,
						status: (p.status as Task['status']) ?? known.status,
						pendingKind: (p.pendingKind as Task['pendingKind']) ?? null,
						title: typeof p.title === 'string' ? p.title : known.title,
						lastActivityAt: e.createdAt || Date.now()
					});
				}
				later('tasks', core.loadTasks); // new task, or summary / cost changed
				later('approvals', core.loadApprovals);
			} else if (e.type === 'approval-needed' || e.type === 'approval-decided') {
				later('approvals', core.loadApprovals);
				later('tasks', core.loadTasks);
			} else if (e.type === 'file-changed') {
				later('files', bump('files'));
			} else if (e.type === 'routine-fired' || e.type === 'routine-changed') {
				later('routines', bump('routines'));
				if (e.type === 'routine-fired') later('tasks', core.loadTasks);
			} else if (e.type === 'providers-changed') {
				// a profile was added, edited or removed (any tab or instance): lists refetch
				later('providers', bump('providers'));
			} else if (e.type === 'settings-changed') {
				later('settings', bump('settings'));
			} else if (e.type === 'mode-changed') {
				// a pick (any tab) or Auto paused / resumed: the mode selector refetches
				later('modes', bump('modes'));
			}
		},

		setViewing(agent: string | null): void {
			state.viewing = agent;
			if (agent) void core.markRead(agent);
		},

		/** Clear the unread dot locally and on the server. Only when the chat is visible. */
		async markRead(agent: string, force = false): Promise<void> {
			const id = agents.find(agent)?.id ?? agent;
			if (!visible()) return;
			const cur = agents.state.activity[id];
			const had = (cur?.unread ?? 0) > 0;
			if (cur) cur.unread = 0;
			if (!had && cur && !force) return; // nothing unread: skip the round trip
			try {
				await api.post('/agents/{id}/read', { params: { id } });
			} catch (e) {
				report(e);
			}
		},

		/** Answer an approval or question. Optimistic: the item leaves the list at once and returns on failure. */
		async answer(a: Approval, body: ApprovalBody): Promise<void> {
			const before = state.approvals;
			state.approvals = before.filter((x) => !(x.id === a.id && x.sessionId === a.sessionId));
			try {
				await api.post('/approvals/{id}', { params: { id: a.id }, body: { ...body, sessionId: a.sessionId } as ApprovalBody });
			} catch (e) {
				state.approvals = before;
				// 404: answered elsewhere, 409: stale. Either way the server is the truth.
				later('approvals', core.loadApprovals);
				throw e;
			}
			later('approvals', core.loadApprovals);
			later('tasks', core.loadTasks);
		},

		/**
		 * What this agent's chat must show inline: its own questions (`ask_user_question`; its own
		 * tool approvals render inside the message) plus every approval or question of the child
		 * sessions it delegated to — like the coder's prompt labelled "from <agent>".
		 */
		chatPending(agentId: string): Approval[] {
			const agent = agents.find(agentId);
			const ids = [agent?.id, agent?.slug, agentId].filter((x): x is string => !!x);
			const own = (a: Approval): boolean => ids.some((id) => a.sessionId === `dm:${id}`);
			return [
				...state.approvals.filter((a) => own(a) && a.kind === 'question'),
				...core.childApprovals(agentId)
			];
		},

		/** Approvals waiting in child sessions of this agent's delegations (lead hint). */
		childApprovals(agentId: string): Approval[] {
			const agent = agents.find(agentId);
			const ids = [agent?.id, agent?.slug, agentId].filter((x): x is string => !!x);
			return state.approvals.filter(
				(a) => a.parentSessionId !== null && ids.some((id) => a.parentSessionId === `dm:${id}` || a.parentSessionId?.startsWith(`dm:${id}:`))
			);
		}
	};
	return core;
}

export type LiveStore = ReturnType<typeof createLiveCore>;
