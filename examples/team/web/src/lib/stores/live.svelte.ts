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
			health: async (signal) => {
				const res = await fetch(`${__PUBLIC_API_URL__ || '/api'}/health`, { signal, cache: 'no-store' });
				if (!res.ok) throw new Error(`health ${res.status}`);
				return (await res.json()) as { boot?: string };
			},
			isBusy: () => live.isBusy(),
			onStatus: (s) => {
				state.connection = s;
				if (s === 'live') state.reconnecting = false;
				else if (s === 'polling') state.reconnecting = true; // the stream failed: server down or unreachable
			}
		});
		// Load what the page shows right away; the stream's resync (on connect) only refreshes it.
		void live.resync();
		if (typeof document !== 'undefined') {
			document.addEventListener('visibilitychange', () => {
				if (document.visibilityState !== 'visible') return;
				void client?.check(); // a sleeping tab may have missed a restart
				if (state.viewing) void live.markRead(state.viewing);
			});
			window.addEventListener('online', () => void client?.check());
			window.addEventListener('focus', () => void client?.check());
		}
	}
	client.start();
	return () => client?.stop();
}
