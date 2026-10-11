// Pure connection-health logic for the events client: staleness, ping cadence, boot-id changes and
// reconnect backoff. No timers, no I/O: the client feeds it a clock.

export type Health = 'connected' | 'stale' | 'reconnecting';

export type BootCheck = 'first' | 'same' | 'changed';

export type LivenessOptions = {
	/** The server's keep-alive period (ms). */
	keepAliveMs?: number;
	/** Extra silence tolerated beyond one keep-alive before the stream counts as stale. */
	graceMs?: number;
	/** Ping /health at most this often while something is running. */
	pingMs?: number;
};

export const KEEP_ALIVE_MS = 15_000;
export const GRACE_MS = 5_000;
export const PING_MS = 5_000;
export const BACKOFF_MS = [250, 500, 1000, 2000, 4000, 5000];

/** Delay before reconnect attempt `failures` (1-based): exponential steps, capped, with up to 50% jitter off. */
export function backoffDelay(failures: number, steps: number[] = BACKOFF_MS, random: () => number = Math.random): number {
	const base = steps[Math.min(Math.max(failures, 1) - 1, steps.length - 1)] ?? 1000;
	return Math.round(base * (0.5 + random() * 0.5));
}

export function createLiveness(o: LivenessOptions = {}) {
	const staleAfter = (o.keepAliveMs ?? KEEP_ALIVE_MS) + (o.graceMs ?? GRACE_MS);
	const pingMs = o.pingMs ?? PING_MS;
	let lastByteAt: number | null = null;
	let lastPingAt = Number.NEGATIVE_INFINITY;
	let boot: string | null = null;
	let up = false;

	return {
		/** A stream was opened and answered. */
		opened(now: number): void {
			up = true;
			lastByteAt = now;
		},
		/** The stream ended or failed. */
		closed(): void {
			up = false;
			lastByteAt = null;
		},
		/** Any byte arrived on the stream (event or keep-alive comment). */
		byte(now: number): void {
			lastByteAt = now;
		},
		health(now: number): Health {
			if (!up) return 'reconnecting';
			return lastByteAt !== null && now - lastByteAt > staleAfter ? 'stale' : 'connected';
		},
		/** Record a boot id (from /health or the stream); says whether it is new, unchanged or a restart. */
		noteBoot(id: string): BootCheck {
			if (boot === null) {
				boot = id;
				return 'first';
			}
			if (boot === id) return 'same';
			boot = id;
			return 'changed';
		},
		/** Time to ping /health? Every `pingMs` while busy; always when the stream is stale. */
		shouldPing(now: number, busy: boolean): boolean {
			const due = now - lastPingAt >= pingMs;
			if (!due) return false;
			if (busy || this.health(now) === 'stale') return true;
			return false;
		},
		pinged(now: number): void {
			lastPingAt = now;
		},
		get boot(): string | null {
			return boot;
		}
	};
}
