// Events client (spec §5.3): one fetch-based SSE reader per tab with reconnect + Last-Event-ID,
// and a polling fallback (`GET /events?after=`) while the stream is down.
import { createSseParser } from './sse';

export type TeamEvent = {
	seq: number;
	type: 'message-added' | 'task-changed' | 'approval-needed' | 'approval-decided' | 'agent-message' | (string & {});
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
	/** Reconnect delays in ms; the last one repeats. */
	backoff?: number[];
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
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
	readonly lastSeq: number | null;
} {
	const base = o.baseUrl.replace(/\/+$/, '');
	const backoff = o.backoff?.length ? o.backoff : [1000, 2000, 5000, 10000];
	const sleep = o.sleep ?? defaultSleep;
	let ctrl: AbortController | undefined;
	let lastSeq: number | null = null;
	let status: Connection = 'idle';

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
		const res = await doFetch(url, { headers: h, signal });
		if (!res.ok || !res.body) throw new Error(`events stream ${res.status}`);
		setStatus('live');
		o.onResync?.();
		const parser = createSseParser((m) => {
			const e = parseEvent(m.data);
			if (e) deliver(e);
		});
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				parser.push(decoder.decode(value, { stream: true }));
			}
		} finally {
			reader.releaseLock?.();
		}
	}

	async function pollPage(signal: AbortSignal, after: number): Promise<{ events: TeamEvent[]; lastSeq: number }> {
		const res = await doFetch(`${base}/events?after=${after}&limit=${POLL_LIMIT}`, {
			headers: { ...headers(), accept: 'application/json' },
			signal
		});
		if (!res.ok) throw new Error(`events poll ${res.status}`);
		return (await res.json()) as { events: TeamEvent[]; lastSeq: number };
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
			for (const e of page.events) deliver(e);
			if (page.events.length < POLL_LIMIT) break;
		}
	}

	async function run(signal: AbortSignal): Promise<void> {
		let failures = 0;
		while (!signal.aborted) {
			setStatus(failures === 0 ? 'connecting' : status);
			try {
				await stream(signal);
				failures = 0; // clean close: reconnect right away (after a short pause)
				await sleep(backoff[0] ?? 1000, signal);
				continue;
			} catch {
				if (signal.aborted) break;
			}
			failures++;
			setStatus('polling');
			try {
				await poll(signal);
			} catch {
				// still down; keep going
			}
			await sleep(backoff[Math.min(failures - 1, backoff.length - 1)] ?? 1000, signal);
		}
	}

	return {
		start(): void {
			if (ctrl && !ctrl.signal.aborted) return;
			ctrl = new AbortController();
			void run(ctrl.signal);
		},
		stop(): void {
			ctrl?.abort();
			setStatus('stopped');
		},
		get lastSeq(): number | null {
			return lastSeq;
		}
	};
}
