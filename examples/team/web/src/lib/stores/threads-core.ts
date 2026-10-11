import type { ApiClient, Thread } from '../api/client';
import type { components } from '../api/schema';

export type DiscussInput = components['schemas']['Discuss'];

export type ThreadsState = {
	/** Every thread of an agent, archived ones included, newest activity first (server order). */
	byAgent: Record<string, { threads: Thread[]; loaded: boolean } | undefined>;
};

export const emptyThreadsState = (): ThreadsState => ({ byAgent: {} });

/** Thread list logic: load, new chat, rename, archive, restore, discuss. The server is the truth. */
export function createThreadsCore(api: ApiClient, state: ThreadsState) {
	const seq: Record<string, number> = {};
	const put = (agentId: string, threads: Thread[]): void => {
		state.byAgent[agentId] = { threads, loaded: true };
	};
	const replace = (agentId: string, t: Thread): void => {
		const cur = state.byAgent[agentId]?.threads ?? [];
		put(agentId, cur.some((x) => x.id === t.id) ? cur.map((x) => (x.id === t.id ? t : x)) : [t, ...cur]);
	};
	return {
		state,
		threadsOf: (agentId: string): Thread[] => state.byAgent[agentId]?.threads ?? [],
		async load(agentId: string): Promise<void> {
			const mine = (seq[agentId] = (seq[agentId] ?? 0) + 1);
			const r = await api.get('/agents/{id}/threads', { params: { id: agentId }, query: { archived: 'true' } });
			if (mine === seq[agentId]) put(agentId, r.threads); // only the newest request writes
		},
		async create(agentId: string, title?: string): Promise<Thread> {
			const t = await api.post('/agents/{id}/threads', { params: { id: agentId }, body: title ? { title } : {} });
			replace(agentId, t);
			return t;
		},
		async rename(agentId: string, threadId: string, title: string): Promise<Thread> {
			const t = await api.patch('/agents/{id}/threads/{threadId}', { params: { id: agentId, threadId }, body: { title } });
			replace(agentId, t);
			return t;
		},
		async archive(agentId: string, threadId: string): Promise<Thread> {
			const t = await api.post('/agents/{id}/threads/{threadId}/archive', { params: { id: agentId, threadId } });
			replace(agentId, t);
			return t;
		},
		async restore(agentId: string, threadId: string): Promise<Thread> {
			const t = await api.post('/agents/{id}/threads/{threadId}/restore', { params: { id: agentId, threadId } });
			replace(agentId, t);
			return t;
		},
		/** A new thread seeded with a briefing item, an alert or a run. */
		async discuss(input: DiscussInput): Promise<Thread> {
			const t = await api.post('/threads/discuss', { body: input });
			replace(t.agentId, t);
			return t;
		}
	};
}
