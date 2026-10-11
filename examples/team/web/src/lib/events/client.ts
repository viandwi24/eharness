// Events client (spec §5.3): one fetch-based SSE reader per tab with reconnect + Last-Event-ID,
// and a polling fallback (`GET /events?after=`) while the stream is down.
import { backoffDelay, BACKOFF_MS, createLiveness, GRACE_MS, KEEP_ALIVE_MS } from './liveness';
import { createSseParser } from './sse';

export type TeamEvent = {
	seq: number;
	type: 'message-added' | 'task-changed' | 'pending-changed' | 'approval-decided' | 'agent-message' | (string & {});
	agentId: string | null;
	sessionId: string | null;
	payload: Record<string, unknown>;
	createdAt: number;
};

export type Connection = 'idle' | 'connecting' | 'live' | 'polling' | 'stopped';

export type EventsClientOptions = {
	baseUrl: string;
	getToken?: () => string | null | undefined;
	fetch?: typeof fetch;
	onEvent: (e: TeamEvent) => void;
	/** The stream (re)connected, or a poll round succeeded after a gap: stores should refetch to resync. */
	onResync?: () => void;
	onStatus?: (s: Connection) => void;
	/** Reconnect delays in ms (jittered, the last one repeats). Default 250 ms up to 5 s. */
	backoff?: number[];
	/** `GET /health` (cheap, no auth): resolves with the server's boot id. Rejects when the server is down. */
	health?: (signal: AbortSignal) => Promise<{ boot?: string }>;
	/** True while a chat or a task is running: the client then pings `health` about every 5 s. */
	isBusy?: () => boolean;
	/** Clock and randomness, injectable for tests. */
	now?: () => number;
	random?: () => number;
	/** Period of the internal health tick (ms). 0 disables it (tests). Default 1000. */
	tickMs?: number;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	/**
	 * No bytes (not even the server's keep-alive comment, every 15 s) for this long: the connection
	 * is dead without an error (a killed server behind a proxy): drop it and reconnect. Default 20 s.
	 */
	idleMs?: number;
};

const POLL_LIMIT = 200;

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
	new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const t = setTimeout(resolve, ms);
		signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
	});

export function parseEvent(data: string): TeamEvent | undefined {
	try {
		const e = JSON.parse(data) as Partial<TeamEvent>;
		if (e && typeof e.seq === 'number' && typeof e.type === 'string') {
			return { agentId: null, sessionId: null, payload: {}, createdAt: 0, ...e } as TeamEvent;
		}
	} catch {
		// ignore malformed frames
	}
	return undefined;
}

export function createEventsClient(o: EventsClientOptions): {
	start(): void;
	stop(): void;
	/** Ping `health` now (tab focus, network back): a failure or a new boot id reconnects at once. */
	check(): Promise<void>;
	readonly lastSeq: number | null;
} {
	const base = o.baseUrl.replace(/\/+$/, '');
	const steps = o.backoff?.length ? o.backoff : BACKOFF_MS;
	const random = o.random ?? Math.random;
	const now = o.now ?? Date.now;
	const liveness = createLiveness();
	let kick: (() => void) | undefined; // drop the current stream and reconnect now
	let wake: (() => void) | undefined; // cut a backoff sleep short
	let pinging = false;
	const sleep = o.sleep ?? defaultSleep;
	let ctrl: AbortController | undefined;
	let lastSeq: number | null = null;
	let status: Connection = 'idle';
	let kicked = false;
	let tick: ReturnType<typeof setInterval> | undefined;

	const setStatus = (s: Connection): void => {
		if (s === status) return;
		status = s;
		o.onStatus?.(s);
	};
	const headers = (): Record<string, string> => {
		const h: Record<string, string> = {};
		const token = o.getToken?.();
		if (token) h.authorization = `Bearer ${token}`;
		return h;
	};
	const deliver = (e: TeamEvent): void => {
		if (lastSeq !== null && e.seq <= lastSeq) return; // replay overlap
		lastSeq = e.seq;
		o.onEvent(e);
	};
	const doFetch = (url: string, init: RequestInit): Promise<Response> => (o.fetch ?? fetch)(url, init);

	async function stream(signal: AbortSignal): Promise<void> {
		const h = headers();
		h.accept = 'text/event-stream';
		let url = `${base}/events/stream`;
		if (lastSeq !== null) {
			url += `?after=${lastSeq}`;
			h['last-event-id'] = String(lastSeq);
		}
		// a silent connection is dropped by the watchdog below
		const inner = new AbortController();
		const onOuterAbort = (): void => inner.abort();
		signal.addEventListener('abort', onOuterAbort, { once: true });
		const idleMs = o.idleMs ?? KEEP_ALIVE_MS + GRACE_MS;
		kick = () => inner.abort();
		let idle: ReturnType<typeof setTimeout> | undefined;
		const arm = (): void => {
			clearTimeout(idle);
			if (idleMs > 0) idle = setTimeout(() => inner.abort(), idleMs);
		};
		arm();
		try {
			await readStream(url, h, inner.signal, arm);
		} finally {
			clearTimeout(idle);
			kick = undefined;
			liveness.closed();
			signal.removeEventListener('abort', onOuterAbort);
		}
	}

	async function readStream(url: string, h: Record<string, string>, signal: AbortSignal, arm: () => void): Promise<void> {
		const res = await doFetch(url, { headers: h, signal });
		if (!res.ok || !res.body) throw new Error(`events stream ${res.status}`);
		arm();
		liveness.opened(now());
		setStatus('live');
		o.onResync?.();
		const parser = createSseParser((m) => {
			if (m.event === 'boot') {
				try {
					const id = (JSON.parse(m.data) as { boot?: unknown }).boot;
					if (typeof id === 'string') liveness.noteBoot(id); // a new boot: onResync above already ran
				} catch {
					// malformed hint
				}
				return;
			}
			if (m.event === 'resync') {
				// the server pruned events newer than our cursor: refetch state, continue from its mark
				const seq = (JSON.parse(m.data) as { seq?: unknown }).seq;
				if (typeof seq === 'number' && (lastSeq === null || seq > lastSeq)) lastSeq = seq;
				o.onResync?.();
				return;
			}
			const e = parseEvent(m.data);
			if (e) deliver(e);
		});
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				arm();
				liveness.byte(now());
				parser.push(decoder.decode(value, { stream: true }));
			}
		} finally {
			reader.releaseLock?.();
		}
	}

	async function pollPage(signal: AbortSignal, after: number): Promise<{ events: TeamEvent[]; lastSeq: number; resync?: boolean }> {
		const res = await doFetch(`${base}/events?after=${after}&limit=${POLL_LIMIT}`, {
			headers: { ...headers(), accept: 'application/json' },
			signal
		});
		if (!res.ok) throw new Error(`events poll ${res.status}`);
		return (await res.json()) as { events: TeamEvent[]; lastSeq: number; resync?: boolean };
	}

	async function poll(signal: AbortSignal): Promise<void> {
		if (lastSeq === null) {
			// First contact: there is no head endpoint, so page to the end without delivering (history is not news).
			let cursor = 0;
			for (;;) {
				const page = await pollPage(signal, cursor);
				cursor = page.lastSeq;
				if (page.events.length < POLL_LIMIT) break;
			}
			lastSeq = cursor;
			o.onResync?.();
			return;
		}
		for (;;) {
			const page = await pollPage(signal, lastSeq);
			if (page.resync) {
				// events between our cursor and the retention mark are gone: refetch state
				o.onResync?.();
			}
			for (const e of page.events) deliver(e);
			if (page.events.length < POLL_LIMIT) break;
		}
	}

	async function run(signal: AbortSignal): Promise<void> {
		let failures = 0;
		const pause = (ms: number): Promise<void> => {
			const w = new Promise<void>((r) => (wake = r));
			return Promise.race([sleep(ms, signal), w]).finally(() => (wake = undefined));
		};
		while (!signal.aborted) {
			setStatus(failures === 0 ? 'connecting' : status);
			try {
				await stream(signal);
				failures = 0; // clean close: reconnect right away (after a short pause)
				if (kicked) {
					kicked = false;
					continue;
				}
				await pause(backoffDelay(1, steps, random));
				continue;
			} catch {
				if (signal.aborted) break;
				if (kicked) {
					// we dropped it on purpose (new boot, failed ping, stale): reconnect without waiting
					kicked = false;
					failures = 0;
					continue;
				}
			}
			failures++;
			setStatus('polling');
			try {
				await poll(signal);
			} catch {
				// still down; keep going
			}
			await pause(backoffDelay(failures, steps, random));
		}
	}

	const reconnectNow = (): void => {
		if (kick) {
			kicked = true;
			kick();
		} else wake?.(); // already down: do not wait out the backoff
	};

	async function check(): Promise<void> {
		if (!o.health || pinging || !ctrl || ctrl.signal.aborted) return;
		pinging = true;
		liveness.pinged(now());
		const t = new AbortController();
		const timer = setTimeout(() => t.abort(), 4000);
		try {
			const h = await o.health(t.signal);
			if (ctrl.signal.aborted) return;
			if (typeof h.boot === 'string' && liveness.noteBoot(h.boot) === 'changed') return reconnectNow();
			if (liveness.health(now()) !== 'connected') reconnectNow(); // it answers but the stream is stale or down
		} catch {
			if (!ctrl.signal.aborted && status === 'live') reconnectNow(); // up on paper, dead in fact
		} finally {
			clearTimeout(timer);
			pinging = false;
		}
	}

	return {
		start(): void {
			if (ctrl && !ctrl.signal.aborted) return;
			ctrl = new AbortController();
			void run(ctrl.signal);
			const every = o.tickMs ?? 1000;
			if (every > 0 && o.health) {
				tick = setInterval(() => {
					if (liveness.shouldPing(now(), o.isBusy?.() ?? false)) void check();
				}, every);
			}
		},
		check,
		stop(): void {
			clearInterval(tick);
			ctrl?.abort();
			setStatus('stopped');
		},
		get lastSeq(): number | null {
			return lastSeq;
		}
	};
}
