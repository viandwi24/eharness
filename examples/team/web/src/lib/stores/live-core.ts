import {
	type ActivityRecord,
	ATTENTION_EVENTS,
	type AttentionAnswerWire,
	createAttentionList,
	type FeedStatus,
	type HarnessClient
} from 'eharness/client';
import type { Approval, ApiClient, ApprovalBody, Task } from '../api/client';
import { upsertTask } from '../board/board';
import { applyActivity } from './activity';
import type { AgentsStore } from './agents-core';

export type LiveState = {
	approvals: Approval[];
	approvalsLoaded: boolean;
	tasks: Task[];
	tasksLoaded: boolean;
	connection: FeedStatus;
	/** The events stream dropped and is being re-established (a server restart, the network). */
	reconnecting: boolean;
	/** Agent id (or slug) of the open chat; null elsewhere. */
	viewing: string | null;
	/** Counters bumped (debounced) by file / routine / settings / mode / message events; screens refetch when one moves. */
	revs: { files: number; routines: number; programs: number; settings: number; modes: number; chat: number; providers: number; connectors: number };
};

export const emptyLiveState = (): LiveState => ({
	approvals: [],
	approvalsLoaded: false,
	tasks: [],
	tasksLoaded: false,
	connection: 'idle',
	reconnecting: false,
	viewing: null,
	revs: { files: 0, routines: 0, programs: 0, settings: 0, modes: 0, chat: 0, providers: 0, connectors: 0 }
});

/** What the team posts to `POST /attention/{id}/answer`: the wire answers plus its question kind. */
export type TeamAnswer = AttentionAnswerWire | { kind: 'question'; answers: Extract<ApprovalBody, { answers: unknown }>['answers'] };

export type LiveDeps = {
	/** The `eharness/http` client: attention answers. */
	client: HarnessClient;
	isVisible?: () => boolean;
	/** Debounce for refetches triggered by events (ms). */
	debounceMs?: number;
	setTimeout?: (fn: () => void, ms: number) => unknown;
	onError?: (e: unknown) => void;
};

/** Live store logic: approvals inbox, task board and sidebar activity, driven by the events feed. */
export function createLiveCore(api: ApiClient, agents: AgentsStore, state: LiveState, deps: LiveDeps) {
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

	// The approvals inbox is the library's attention list (optimistic answers, generation guard,
	// debounced refetch). The team reads `GET /approvals` (the enriched view: agent name, task,
	// question texts) and answers questions with its own `question` kind (`attention.parseAnswer`).
	const attention = createAttentionList<Approval, TeamAnswer>({
		client: deps.client,
		list: async () => (await api.get('/approvals')).approvals,
		events: [...ATTENTION_EVENTS, 'task-changed'],
		debounceMs: debounce,
		clock: { setTimeout: (fn, ms) => timer(fn, ms) },
		onError: report
	});
	attention.subscribe((s) => {
		state.approvals = [...s.items];
		state.approvalsLoaded = s.loaded;
	});

	// A task list fetched while a newer event arrived is stale: it must not overwrite what that event
	// applied. `gen` counts events; a fetch that saw a later event refetches, and only the newest
	// request may write.
	let tasksGen = 0;
	let tasksReq = 0;
	async function fetchTasks(): Promise<void> {
		const atGen = tasksGen;
		const mine = ++tasksReq;
		try {
			const list = (await api.get('/tasks', { query: { limit: 200 } })).tasks;
			if (mine !== tasksReq) return; // a newer request writes
			state.tasks = list;
			state.tasksLoaded = true;
			if (atGen !== tasksGen) later('tasks', core.loadTasks);
		} catch (e) {
			report(e);
		}
	}

	const bump = (k: keyof LiveState['revs']) => async (): Promise<void> => {
		state.revs[k]++;
	};

	const chatListeners = new Set<(e: ActivityRecord) => void>();
	const modelCallListeners = new Set<(e: ActivityRecord) => void>();
	const resyncListeners = new Set<() => void>();
	const busyProbes = new Set<() => boolean>();

	const core = {
		state,

		/** Chat activity of DM sessions (`turn-started`, `message-added`): open chats follow server turns. */
		onChatEvent(fn: (e: ActivityRecord) => void): () => void {
			chatListeners.add(fn);
			return () => chatListeners.delete(fn);
		},

		/** `model-call` events (one per logged provider call): the Logs page prepends rows. */
		onModelCallEvent(fn: (e: ActivityRecord) => void): () => void {
			modelCallListeners.add(fn);
			return () => modelCallListeners.delete(fn);
		},

		loadApprovals: (): Promise<void> => attention.refresh(),

		loadTasks: fetchTasks,

		/** Something runs that should show up live: a task, or a chat probe (`addBusyProbe`). Drives the restart pings. */
		isBusy(): boolean {
			if (state.tasks.some((t) => t.status === 'running')) return true;
			for (const p of busyProbes) if (p()) return true;
			return false;
		},

		addBusyProbe(fn: () => boolean): () => void {
			busyProbes.add(fn);
			return () => busyProbes.delete(fn);
		},

		/** The stream (re)connected or the cursor was pruned: open chats, panels and lists refetch too. */
		onResync(fn: () => void): () => void {
			resyncListeners.add(fn);
			return () => resyncListeners.delete(fn);
		},

		async resync(): Promise<void> {
			for (const k of Object.keys(state.revs) as (keyof LiveState['revs'])[]) state.revs[k]++; // files, routines, programs, settings, modes, chat, providers, connectors
			for (const fn of resyncListeners) {
				try {
					fn();
				} catch (error) {
					report(error);
				}
			}
			await Promise.all([core.loadApprovals(), core.loadTasks(), agents.load()]);
		},

		handleEvent(e: ActivityRecord): void {
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
			attention.handleActivity(e); // pending-changed, approval-decided, turn-ended, ...: the list refetches
			if (e.type === 'task-changed' || e.type === 'pending-changed' || e.type === 'approval-decided') tasksGen++;
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
			} else if (e.type === 'pending-changed' || e.type === 'approval-decided') {
				later('tasks', core.loadTasks);
			} else if (e.type === 'file-changed') {
				later('files', bump('files'));
			} else if (e.type === 'routine-fired' || e.type === 'routine-changed') {
				later('routines', bump('routines'));
				if (e.type === 'routine-fired') later('tasks', core.loadTasks);
			} else if (e.type === 'program-changed') {
				later('programs', bump('programs'));
			} else if (e.type === 'providers-changed') {
				// a profile was added, edited or removed (any tab or instance): lists refetch
				later('providers', bump('providers'));
			} else if (e.type === 'connectors-changed') {
				// a connection, a credential or an agent's enablement changed (any tab or instance)
				later('connectors', bump('connectors'));
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

		/**
		 * Answer an approval or question. Optimistic (the library list): the item leaves at once and
		 * returns on failure, except when it was answered elsewhere. Rejects with the `HarnessHttpError`.
		 */
		async answer(a: Approval, body: ApprovalBody): Promise<void> {
			const wire: TeamAnswer = 'answers' in body ? { kind: 'question', answers: body.answers } : { kind: 'approval', ...body };
			await attention.answer(a, wire);
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

		/**
		 * The approval of this agent's OWN DM session with that id (what an inline card of its
		 * message may answer). A child's approval is never answered from the lead's message.
		 */
		ownApproval(agentId: string, approvalId: string): Approval | undefined {
			const agent = agents.find(agentId);
			const ids = [agent?.id, agent?.slug, agentId].filter((x): x is string => !!x);
			return state.approvals.find((a) => a.id === approvalId && a.kind === 'approval' && ids.some((id) => a.sessionId === `dm:${id}`));
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
