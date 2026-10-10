import type { FlowSession } from '#lib/connectors/flow-core.js';
import { pollIntervalOf } from '#lib/connectors/flow-core.js';
import type { FlowView } from '#lib/api/index.js';

/**
 * Polls a waiting view (OAuth, device code) every `pollIntervalMs` while the component lives, and
 * once more whenever the window regains focus. Call inside a component's script: it registers an
 * effect that cleans its timer up. A poll never overlaps the previous one.
 */
export function usePolling(session: FlowSession, getView: () => FlowView): void {
	$effect(() => {
		const view = getView();
		const ms = pollIntervalOf(view);
		if (ms === null) return;
		let stopped = false;
		let running = false;
		const tick = async (): Promise<void> => {
			if (stopped || running || session.state.busy) return;
			running = true;
			try {
				await session.poll();
			} finally {
				running = false;
			}
		};
		const timer = setInterval(() => void tick(), ms);
		const onFocus = (): void => void tick();
		window.addEventListener('focus', onFocus);
		return () => {
			stopped = true;
			clearInterval(timer);
			window.removeEventListener('focus', onFocus);
		};
	});
}

/** A clock that ticks every second (for expiry texts). */
export function useNow(): { readonly value: number } {
	let now = $state(Date.now());
	$effect(() => {
		const t = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(t);
	});
	return {
		get value() {
			return now;
		}
	};
}
