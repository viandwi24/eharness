// Svelte action: calls `onSee` once, when the element first comes near the viewport (so a blob is
// fetched only for what is scrolled to). Without IntersectionObserver it fires at once.
export function inView(node: HTMLElement, onSee: () => void): { destroy(): void } {
	if (typeof IntersectionObserver === 'undefined') {
		onSee();
		return { destroy() {} };
	}
	const io = new IntersectionObserver(
		(entries) => {
			if (!entries.some((e) => e.isIntersecting)) return;
			io.disconnect();
			onSee();
		},
		{ rootMargin: '200px' }
	);
	io.observe(node);
	return { destroy: () => io.disconnect() };
}
