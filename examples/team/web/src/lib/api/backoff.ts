// Bounded exponential backoff for requests that keep failing (pure, injectable clock). After
// `threshold` failures in a row the gate closes for `baseMs * 2^n` (capped at `maxMs`); one request
// is let through when the time is up (a probe), the rest wait for its answer. Any success reopens it.

export type BackoffOptions = { baseMs?: number; maxMs?: number; threshold?: number; now?: () => number };

export type Backoff = {
	/** May a request go out now? When it may and the gate is closed, this request is the probe (the gate shuts again for the next delay). */
	tryAcquire(): boolean;
	failure(): void;
	success(): void;
	/** Open the gate at once (the Retry button). */
	reset(): void;
	/** `threshold` or more failures in a row. */
	readonly down: boolean;
	/** Milliseconds until the next request is let through; 0 when open. */
	waitMs(): number;
	subscribe(fn: (down: boolean) => void): () => void;
};

export function createBackoff(o: BackoffOptions = {}): Backoff {
	const base = o.baseMs ?? 500;
	const max = o.maxMs ?? 30_000;
	const threshold = o.threshold ?? 3;
	const now = o.now ?? Date.now;
	let failures = 0;
	let openAt = 0;
	const listeners = new Set<(down: boolean) => void>();
	const delay = (): number => Math.min(max, base * 2 ** Math.max(0, failures - threshold));
	const emit = (): void => {
		for (const fn of listeners) fn(failures >= threshold);
	};
	return {
		tryAcquire() {
			if (failures < threshold) return true;
			if (now() < openAt) return false;
			openAt = now() + delay(); // one probe per window
			return true;
		},
		failure() {
			const wasDown = failures >= threshold;
			failures++;
			if (failures >= threshold) openAt = now() + delay();
			if (!wasDown && failures >= threshold) emit();
		},
		success() {
			const wasDown = failures >= threshold;
			failures = 0;
			openAt = 0;
			if (wasDown) emit();
		},
		reset() {
			openAt = 0;
		},
		get down() {
			return failures >= threshold;
		},
		waitMs() {
			return failures < threshold ? 0 : Math.max(0, openAt - now());
		},
		subscribe(fn) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		}
	};
}
