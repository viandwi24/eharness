import { describe, expect, test } from 'bun:test';
import { deltaOfLine, readStreamText } from './sse';

const sse = (...chunks: unknown[]): string => `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;

describe('sse', () => {
	test('lines', () => {
		expect(deltaOfLine('data: {"type":"text-delta","id":"1","delta":"Hi"}')).toBe('Hi');
		expect(deltaOfLine('data: [DONE]')).toBeNull();
		expect(deltaOfLine('data: {"type":"start"}')).toBeUndefined();
		expect(deltaOfLine(': ping')).toBeUndefined();
		expect(deltaOfLine('data: nope')).toBeUndefined();
	});

	test('reads the text of a stream split anywhere', async () => {
		const body = sse({ type: 'start' }, { type: 'text-start', id: 'a' }, { type: 'text-delta', id: 'a', delta: 'Hel' }, { type: 'text-delta', id: 'a', delta: 'lo' }, { type: 'finish' });
		const half = Math.floor(body.length / 2);
		const enc = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(enc.encode(body.slice(0, half)));
				c.enqueue(enc.encode(body.slice(half)));
				c.close();
			}
		});
		const seen: string[] = [];
		const text = await readStreamText(new Response(stream), (t) => seen.push(t));
		expect(text).toBe('Hello');
		expect(seen).toEqual(['Hel', 'Hello']);
	});
});
