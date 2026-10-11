import type { ApiClient } from '../api/client';
import type { components } from '../api/schema';
import type { TeamMode } from '../modes';

export type ModeState = components['schemas']['ModeState'];

export type ModesState = {
	/** Mode state per chat: the agent id, or `<agentId>#<threadId>` for a thread (`modeKey`). */
	byAgent: Record<string, ModeState | undefined>;
	error: string | null;
};

/** Key of a chat's mode in the store. */
export const modeKey = (agentId: string, threadId?: string): string => (threadId ? `${agentId}#${threadId}` : agentId);

export const emptyModesState = (): ModesState => ({ byAgent: {}, error: null });

/** Mode selector logic: load the mode of a chat, pick another. The server is the truth. */
export function createModesCore(api: ApiClient, state: ModesState) {
	const message = (e: unknown): string => (e instanceof Error ? e.message : 'Could not change the mode');
	return {
		state,
		async load(agentId: string, threadId?: string): Promise<void> {
			const key = modeKey(agentId, threadId);
			try {
				state.byAgent[key] = await api.get('/agents/{id}/mode', { params: { id: agentId }, query: threadId ? { thread: threadId } : {} });
				state.error = null;
			} catch (e) {
				state.error = message(e);
			}
		},
		/** Optimistic: the selector moves at once and snaps back when the server refuses. */
		async set(agentId: string, mode: TeamMode, threadId?: string): Promise<void> {
			const key = modeKey(agentId, threadId);
			const before = state.byAgent[key];
			if (before) state.byAgent[key] = { ...before, mode, source: 'chat' };
			try {
				state.byAgent[key] = await api.put('/agents/{id}/mode', { params: { id: agentId }, query: threadId ? { thread: threadId } : {}, body: { mode } });
				state.error = null;
			} catch (e) {
				state.byAgent[key] = before;
				state.error = message(e);
				throw e;
			}
		}
	};
}
