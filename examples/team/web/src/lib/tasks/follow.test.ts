/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import type { UIMessage } from 'ai';
import { followTaskStream, mergeLive, parseChunkStream, pollDelay, taskIdOfSession, upsertMessage } from './follow.ts';

const sse = (chunks: unknown[], status = 200): Response =>
	new Response(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`, { status });

const turn = [
	{ type: 'start', messageId: 'm1' },
	{ type: 'start-step' },
	{ type: 'text-start', id: 't' },
	{ type: 'text-delta', id: 't', delta: 'hel' },
	{ type: 'text-delta', id: 't', delta: 'lo' },
	{ type: 'text-end', id: 't' },
	{ type: 'finish-step' },
	{ type: 'finish' }
];

describe('polling decision', () => {
	test('polls only a running task that is not streaming', () => {
		expect(pollDelay({ status: 'running', streaming: false })).toBe(1000);
		expect(pollDelay({ status: 'running', streaming: true })).toBeNull();
		expect(pollDelay({ status: 'done', streaming: false })).toBeNull();
		expect(pollDelay({ status: 'needs_action', streaming: false })).toBeNull();
		expect(pollDelay({ status: 'running', streaming: false, visible: false })).toBe(5000);
	});
});

describe('id mapping and merging', () => {
	test('child session id maps to its task id', () => {
		const tasks = [{ id: 't1', sessionId: 's1' }, { id: 't2', sessionId: 's2' }];
		expect(taskIdOfSession(tasks, 's2')).toBe('t2');
		expect(taskIdOfSession(tasks, 'nope')).toBeUndefined();
	});
	test('upsert replaces by id or appends', () => {
		expect(upsertMessage([{ id: 'a', v: 1 }], { id: 'a', v: 2 })).toEqual([{ id: 'a', v: 2 }]);
		expect(upsertMessage([{ id: 'a', v: 1 }], { id: 'b', v: 2 }).map((m) => m.id)).toEqual(['a', 'b']);
	});
	test('live messages override stored ones by id', () => {
		const stored = [{ id: 'a', role: 'user', parts: [] }, { id: 'm1', role: 'assistant', parts: [] }] as UIMessage[];
		const live = new Map([['m1', { id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'x' }] } as UIMessage]]);
		const out = mergeLive(stored, live);
		expect(out).toHaveLength(2);
		expect(out[1]?.parts).toHaveLength(1);
	});
});

describe('chunk application', () => {
	test('parseChunkStream splits SSE events across reads', async () => {
		const text = `data: ${JSON.stringify(turn[0])}\n\ndata: ${JSON.stringify(turn[1])}\n\ndata: [DONE]\n\n`;
		const bytes = new TextEncoder().encode(text);
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(bytes.slice(0, 17));
				c.enqueue(bytes.slice(17));
				c.close();
			}
		});
		const out: unknown[] = [];
		const reader = parseChunkStream(body).getReader();
		for (let r = await reader.read(); !r.done; r = await reader.read()) out.push(r.value);
		expect(out).toEqual([turn[0], turn[1]]);
	});

	test('builds the streamed message', async () => {
		const seen: UIMessage[] = [];
		const r = await followTaskStream({
			url: 'x',
			fetch: async () => sse(turn),
			onMessage: (m) => seen.push(structuredClone(m))
		});
		expect(r).toBe('streamed');
		const last = seen.at(-1);
		expect(last?.id).toBe('m1');
		expect(last?.parts.find((p) => p.type === 'text')).toMatchObject({ text: 'hello' });
	});

	test('a replayed continuation extends the stored message', async () => {
		// what the library's resume route sends for a respond() continuation (spec 04 §6.3)
		const seen: UIMessage[] = [];
		await followTaskStream({
			url: 'x',
			fetch: async () =>
				sse([
					{ type: 'start', messageId: 'm1' },
					{ type: 'start-step' },
					{ type: 'tool-input-available', toolCallId: 'c1', toolName: 'bash', input: { c: 1 } },
					{ type: 'finish-step' },
					{ type: 'tool-output-available', toolCallId: 'c1', output: 'ok' },
					{ type: 'finish' }
				]),
			onMessage: (m) => seen.push(structuredClone(m))
		});
		expect(seen.at(-1)?.parts.find((p) => p.type === 'tool-bash')).toMatchObject({ state: 'output-available' });
	});

	test('204 is idle, errors are reported', async () => {
		const base = { url: 'x', onMessage: () => {} };
		expect(await followTaskStream({ ...base, fetch: async () => new Response(null, { status: 204 }) })).toBe('idle');
		expect(await followTaskStream({ ...base, fetch: async () => new Response('no', { status: 500 }) })).toBe('error');
		expect(
			await followTaskStream({
				...base,
				fetch: async () => {
					throw new Error('down');
				}
			})
		).toBe('error');
	});
});
