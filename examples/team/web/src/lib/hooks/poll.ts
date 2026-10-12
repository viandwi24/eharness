/**
 * Calls `fn` every `ms` while the page is visible, and once when it becomes visible again (a hidden
 * tab does not poll, so it must catch up when the person returns). Returns the stop function.
 * `visible` and `listen` are injectable for tests.
 */
export function pollWhileVisible(
	fn: () => void,
	ms = 5000,
	env: { visible?: () => boolean; listen?: (cb: () => void) => () => void } = {}
): () => void {
	const visible = env.visible ?? (() => typeof document === 'undefined' || document.visibilityState === 'visible');
	const listen =
		env.listen ??
		((cb: () => void) => {
			if (typeof document === 'undefined') return () => undefined;
			document.addEventListener('visibilitychange', cb);
			return () => document.removeEventListener('visibilitychange', cb);
		});
	const timer = setInterval(() => {
		if (visible()) fn();
	}, ms);
	const stopListening = listen(() => {
		if (visible()) fn();
	});
	return () => {
		clearInterval(timer);
		stopListening();
	};
}
