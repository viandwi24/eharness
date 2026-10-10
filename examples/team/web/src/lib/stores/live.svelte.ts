import { api, getToken } from '../api/index';
import { createEventsClient } from '../events/client';
import { agentsStore } from './agents.svelte.js';
import { createLiveCore, emptyLiveState } from './live-core';

declare const __PUBLIC_API_URL__: string;

const state = $state(emptyLiveState());
export const live = createLiveCore(api, agentsStore, state, {
	isVisible: () => typeof document === 'undefined' || document.visibilityState === 'visible'
});

let client: ReturnType<typeof createEventsClient> | undefined;

/** Start the tab's single events connection (idempotent). Returns a stop function. */
export function startLive(): () => void {
	if (!client) {
		client = createEventsClient({
			baseUrl: __PUBLIC_API_URL__ || '/api',
			getToken,
			onEvent: (e) => live.handleEvent(e),
			onResync: () => void live.resync(),
			onStatus: (s) => (state.connection = s)
		});
		// Load what the page shows right away; the stream's resync (on connect) only refreshes it.
		void live.resync();
		if (typeof document !== 'undefined') {
			document.addEventListener('visibilitychange', () => {
				if (document.visibilityState === 'visible' && state.viewing) void live.markRead(state.viewing);
			});
		}
	}
	client.start();
	return () => client?.stop();
}
