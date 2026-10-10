import { describe, expect, test } from 'bun:test';
import { createEventsClient, type Connection, type TeamEvent } from './client';

const ev = (seq: number, type = 'message-added'): TeamEvent => ({ seq, type, agentId: 'a', sessionId: null, payload: {}, createdAt: 1 });
const frame = (e: TeamEvent): string => `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
const sse = (text: string): Response => {
	const enc = new TextEncoder();
	return new Response(
		new ReadableStream({
			start(c) {
				c.enqueue(enc.encode(text));
				c.close();
			}
		}),
		{ status: 200, headers: { 'content-type': 'text/event-stream' } }
	);
};
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

type Call = { url: string; headers: Record<string, string> };

/** Run until `until()` or a safety cap, with sleeps resolved immediately. */
async function drive(handler: (url: string, n: number) => Response | Promise<Response>, stopAfter: number) {
	const calls: Call[] = [];
	const events: TeamEvent[] = [];
	const status: Connection[] = [];
	let resyncs = 0;
	let client!: ReturnType<typeof createEventsClient>;
	client = createEventsClient({
		baseUrl: '/api/',
		getToken: () => 'tok',
		fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers)) });
			return handler(String(input), calls.length);
		}) as typeof fetch,
		onEvent: (e) => events.push(e),
		onResync: () => resyncs++,
		onStatus: (s) => status.push(s),
		sleep: async () => {
			await Promise.resolve();
			if (calls.length >= stopAfter) client.stop();
		}
	});
	client.start();
	for (let i = 0; i < 200 && status.at(-1) !== 'stopped'; i++) await new Promise((r) => setTimeout(r, 1));
	return { calls, events, status, resyncs, client };
}

describe('events client', () => {
	test('streams with bearer, resumes with Last-Event-ID after the stream ends, dedups replays', async () => {
		const r = await drive((url, n) => (n === 1 ? sse(frame(ev(1)) + frame(ev(2))) : sse(frame(ev(2)) + frame(ev(3)))), 2);
		expect(r.events.map((e) => e.seq)).toEqual([1, 2, 3]);
		expect(r.calls[0]?.url).toBe('/api/events/stream');
		expect(r.calls[0]?.headers.authorization).toBe('Bearer tok');
		expect(r.calls[1]?.url).toBe('/api/events/stream?after=2');
		expect(r.calls[1]?.headers['last-event-id']).toBe('2');
		expect(r.resyncs).toBe(2);
	});

	test('falls back to polling when the stream fails, then recovers', async () => {
		const r = await drive((url, n) => {
			if (url.includes('/events/stream')) return n >= 5 ? sse(frame(ev(9))) : json({}, 503);
			if (url.includes('after=0')) return json({ events: [ev(1)], lastSeq: 1 });
			return json({ events: [ev(2), ev(3)], lastSeq: 3 });
		}, 5);
		// first poll (no cursor yet) only finds the head; the next one delivers
		expect(r.status).toContain('polling');
		expect(r.events.map((e) => e.seq)).toEqual([2, 3, 9]);
		expect(r.calls.some((c) => c.url.startsWith('/api/events?after=1'))).toBe(true);
		expect(r.status).toContain('live');
	});

	test('an unreachable server never throws and ends in stopped on stop()', async () => {
		const r = await drive(() => {
			throw new Error('offline');
		}, 4);
		expect(r.events).toEqual([]);
		expect(r.status.at(-1)).toBe('stopped');
	});

	test('a resync frame refetches state and moves the cursor to the retention mark', async () => {
		const resyncFrame = 'event: resync\ndata: {"seq":40}\n\n';
		const r = await drive((_url, n) => (n === 1 ? sse(resyncFrame + frame(ev(41))) : sse('')), 2);
		expect(r.events.map((e) => e.seq)).toEqual([41]);
		expect(r.resyncs).toBe(3); // connect, the frame, the reconnect
		expect(r.calls[1]?.url).toBe('/api/events/stream?after=41');
	});

	test('a poll page flagged resync refetches state', async () => {
		const r = await drive((url, n) => {
			if (url.includes('/events/stream')) return n === 1 ? sse(frame(ev(5))) : new Response('no', { status: 500 });
			return json({ events: [ev(9)], lastSeq: 9, resync: true });
		}, 4);
		expect(r.events.map((e) => e.seq)).toEqual([5, 9]);
		expect(r.resyncs).toBeGreaterThanOrEqual(2);
	});
});
