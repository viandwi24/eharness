import { type ActivityFeed, createActivityFeed } from 'eharness/client';
import { api, harness } from '../api/index';
import { agentsStore } from './agents.svelte.js';
import { createLiveCore, emptyLiveState } from './live-core';

const state = $state(emptyLiveState());
export const live = createLiveCore(api, agentsStore, state, {
	client: harness,
	isVisible: () => typeof document === 'undefined' || document.visibilityState === 'visible'
});

let feed: ActivityFeed | undefined;

/** Start the tab's single events connection (idempotent). Returns a stop function. */
export function startLive(): () => void {
	if (!feed) {
		const f = createActivityFeed({
			client: harness,
			onEvent: (e) => live.handleEvent(e),
			// (re)connected, a restarted server (new boot id), a pruned cursor: refetch everything
			onResync: () => void live.resync(),
			// ping /health while something runs: a killed server behind the proxy is noticed at once
			isBusy: () => live.isBusy()
		});
		f.subscribe((s) => {
			state.connection = s.status;
			if (s.status === 'live') state.reconnecting = false;
			else if (s.status === 'polling') state.reconnecting = true; // the stream failed: server down or unreachable
		});
		feed = f;
		// Load what the page shows right away; the stream's resync (on connect) only refreshes it.
		void live.resync();
		if (typeof document !== 'undefined') {
			document.addEventListener('visibilitychange', () => {
				if (document.visibilityState !== 'visible') return;
				void feed?.check(); // a sleeping tab may have missed a restart
				if (state.viewing) void live.markRead(state.viewing);
			});
			window.addEventListener('online', () => void feed?.check());
			window.addEventListener('focus', () => void feed?.check());
		}
	}
	feed.start();
	return () => feed?.stop();
}
