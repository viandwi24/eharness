import type { Agent, AgentCreate, AgentPatch, ApiClient } from '../api/client';

/** Plain shape; the `.svelte.ts` wrapper hands in a `$state` proxy so mutations are reactive. */
/** Sidebar extras that come later from the events feed (spec §5.3); all optional. */
export type AgentActivity = { preview?: string; time?: string; unread?: boolean };

export type AgentsState = {
	agents: Agent[];
	activity: Record<string, AgentActivity>;
	loaded: boolean;
	loading: boolean;
	error: string | null;
};

export const emptyAgentsState = (): AgentsState => ({ agents: [], activity: {}, loaded: false, loading: false, error: null });

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Agents list + CRUD over the API. Optimistic where cheap: edits and archive roll back on failure. */
export function createAgentsCore(api: ApiClient, state: AgentsState) {
	const find = (idOrSlug: string): Agent | undefined =>
		state.agents.find((a) => a.id === idOrSlug || a.slug === idOrSlug);

	const replace = (agent: Agent): void => {
		const i = state.agents.findIndex((a) => a.id === agent.id);
		if (i >= 0) state.agents[i] = agent;
		else state.agents.push(agent);
	};

	return {
		state,
		find,

		async load(): Promise<void> {
			state.loading = true;
			try {
				state.agents = (await api.get('/agents')).agents;
				state.error = null;
				state.loaded = true;
			} catch (e) {
				state.error = message(e);
			} finally {
				state.loading = false;
			}
		},

		/** Cached agent, else fetched (also covers agents not in the list, e.g. archived). */
		async get(idOrSlug: string): Promise<Agent> {
			const cached = find(idOrSlug);
			if (cached) return cached;
			const agent = await api.get('/agents/{id}', { params: { id: idOrSlug } });
			replace(agent);
			return agent;
		},

		async create(input: AgentCreate): Promise<Agent> {
			const agent = await api.post('/agents', { body: input });
			replace(agent);
			return agent;
		},

		async update(id: string, patch: AgentPatch): Promise<Agent> {
			const before = find(id);
			if (before) replace({ ...before, ...(patch as Partial<Agent>) } as Agent);
			try {
				const agent = await api.patch('/agents/{id}', { params: { id }, body: patch });
				replace(agent);
				return agent;
			} catch (e) {
				if (before) replace(before);
				throw e;
			}
		},

		async archive(id: string): Promise<void> {
			const before = find(id);
			const index = before ? state.agents.indexOf(before) : -1;
			if (before) state.agents = state.agents.filter((a) => a.id !== before.id);
			try {
				await api.delete('/agents/{id}', { params: { id } });
			} catch (e) {
				if (before) state.agents.splice(Math.min(index, state.agents.length), 0, before);
				throw e;
			}
		}
	};
}

export type AgentsStore = ReturnType<typeof createAgentsCore>;
