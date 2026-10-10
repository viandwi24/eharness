import type { ApiClient } from '../api/client';
import type { components } from '../api/schema';
import type { TeamMode } from '../modes';

export type ModeState = components['schemas']['ModeState'];

export type ModesState = {
	/** Mode state per agent id (the DM chat of that agent). */
	byAgent: Record<string, ModeState | undefined>;
	error: string | null;
};

export const emptyModesState = (): ModesState => ({ byAgent: {}, error: null });

/** Mode selector logic: load the mode of a chat, pick another. The server is the truth. */
export function createModesCore(api: ApiClient, state: ModesState) {
	const message = (e: unknown): string => (e instanceof Error ? e.message : 'Could not change the mode');
	return {
		state,
		async load(agentId: string): Promise<void> {
			try {
				state.byAgent[agentId] = await api.get('/agents/{id}/mode', { params: { id: agentId } });
				state.error = null;
			} catch (e) {
				state.error = message(e);
			}
		},
		/** Optimistic: the selector moves at once and snaps back when the server refuses. */
		async set(agentId: string, mode: TeamMode): Promise<void> {
			const before = state.byAgent[agentId];
			if (before) state.byAgent[agentId] = { ...before, mode, source: 'chat' };
			try {
				state.byAgent[agentId] = await api.put('/agents/{id}/mode', { params: { id: agentId }, body: { mode } });
				state.error = null;
			} catch (e) {
				state.byAgent[agentId] = before;
				state.error = message(e);
				throw e;
			}
		}
	};
}
