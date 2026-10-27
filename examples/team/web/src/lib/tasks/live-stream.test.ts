/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import { isClippedPart } from 'eharness/client';
import { clipChunk, coalesceDeltas, foldTaskStream, usageOf, type TurnUsage } from './live-stream.ts';

/** A long worker turn: every step thinks in many small deltas, then calls tools with big outputs. */
function longTurn(steps: number): UIMessageChunk[] {
	const out: UIMessageChunk[] = [{ type: 'start', messageId: 'm1' }];
	for (let s = 0; s < steps; s++) {
		out.push({ type: 'start-step' });
		out.push({ type: 'reasoning-start', id: `r${s}` });
		for (let d = 0; d < 60; d++) out.push({ type: 'reasoning-delta', id: `r${s}`, delta: 'thinking about the data ' });
		out.push({ type: 'reasoning-end', id: `r${s}` });
		for (let t = 0; t < 2; t++) {
			const id = `c${s}_${t}`;
			out.push({ type: 'tool-input-start', toolCallId: id, toolName: 'call_api' });
			out.push({ type: 'tool-input-available', toolCallId: id, toolName: 'call_api', input: { path: '/chats', page: s } });
			const rows = Array.from({ length: 80 }, (_, i) => ({ id: i, name: `customer ${i}`, delay: i * 3 }));
			out.push({ type: 'tool-output-available', toolCallId: id, output: { rows } });
		}
		out.push({ type: 'data-eh.usage', data: { inputTokens: 0, outputTokens: 0, totalTokens: 0, steps: s + 1, costUsd: (s + 1) / 100 }, transient: true } as UIMessageChunk);
		out.push({ type: 'finish-step' });
	}
	out.push({ type: 'text-start', id: 't' });
	for (const w of ['The ', 'answer ', 'is ', 'done.']) out.push({ type: 'text-delta', id: 't', delta: w });
	out.push({ type: 'text-end', id: 't' });
	out.push({ type: 'finish' });
	return out;
}

const streamOf = (chunks: UIMessageChunk[]): ReadableStream<UIMessageChunk> =>
	new ReadableStream({
		start(c) {
			for (const x of chunks) c.enqueue(x);
			c.close();
		}
	});

async function collect(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
	const out: UIMessageChunk[] = [];
	for await (const c of stream) out.push(c);
	return out;
}

describe('coalesceDeltas', () => {
	test('merges consecutive deltas of the same part and keeps the order of the rest', async () => {
		const out = await collect(
			streamOf([
				{ type: 'text-start', id: 'a' },
				{ type: 'text-delta', id: 'a', delta: 'Hel' },
				{ type: 'text-delta', id: 'a', delta: 'lo' },
				{ type: 'reasoning-delta', id: 'r', delta: 'x' },
				{ type: 'text-delta', id: 'a', delta: '!' },
				{ type: 'text-end', id: 'a' }
			]).pipeThrough(coalesceDeltas())
		);
		expect(out).toEqual([
			{ type: 'text-start', id: 'a' },
			{ type: 'text-delta', id: 'a', delta: 'Hello' },
			{ type: 'reasoning-delta', id: 'r', delta: 'x' },
			{ type: 'text-delta', id: 'a', delta: '!' },
			{ type: 'text-end', id: 'a' }
		]);
	});

	test('a held delta goes out after the hold time while the stream stays open', async () => {
		const ts = coalesceDeltas(10);
		const w = ts.writable.getWriter();
		const r = ts.readable.getReader();
		void w.write({ type: 'text-delta', id: 'a', delta: 'hi' });
		const first = await r.read();
		expect(first.value).toEqual({ type: 'text-delta', id: 'a', delta: 'hi' });
		void w.close();
	});
});

describe('clipChunk', () => {
	test('clips a big tool output into the server preview shape', () => {
		const big = { type: 'tool-output-available', toolCallId: 'c', output: { text: 'x'.repeat(5000) } } as UIMessageChunk;
		const out = clipChunk(big, 2000) as { output: { eharnessClipped: boolean; preview: string } };
		expect(out.output.eharnessClipped).toBe(true);
		expect(out.output.preview.length).toBe(2000);
		expect(isClippedPart({ type: 'dynamic-tool', output: out.output })).toBe(true);
	});

	test('leaves small payloads and transient data alone', () => {
		const small = { type: 'tool-output-available', toolCallId: 'c', output: { ok: true } } as UIMessageChunk;
		expect(clipChunk(small, 2000)).toBe(small);
		const usage = { type: 'data-eh.usage', data: { blob: 'x'.repeat(5000) }, transient: true } as UIMessageChunk;
		expect(clipChunk(usage, 2000)).toBe(usage);
	});
});

test('usageOf reads the turn totals', () => {
	expect(usageOf({ type: 'data-eh.usage', data: { steps: 3, costUsd: 0.2 } } as UIMessageChunk)).toEqual({ steps: 3, costUsd: 0.2 });
	expect(usageOf({ type: 'data-eh.usage', data: { steps: 3 } } as UIMessageChunk)).toEqual({ steps: 3 });
	expect(usageOf({ type: 'start-step' })).toBeUndefined();
});

async function fold(chunks: UIMessageChunk[]): Promise<{ snapshots: number; last?: UIMessage; usage?: TurnUsage; ms: number }> {
	let snapshots = 0;
	let last: UIMessage | undefined;
	let usage: TurnUsage | undefined;
	const t0 = performance.now();
	await foldTaskStream(streamOf(chunks), {
		onMessage: (m) => {
			snapshots++;
			last = m;
		},
		onUsage: (u) => (usage = u)
	});
	return { snapshots, last, usage, ms: performance.now() - t0 };
}

describe('a long task (reproduction of the frozen task panel)', () => {
	// Before: the panel folded every chunk with `readUIMessageStream` and cloned each snapshot. On
	// 120 such steps (8,528 chunks) that was 8,167 full copies and ~29 s of main thread; on 200 steps
	// ~83 s. Measured with this fixture on an M-series Mac.
	test('folds hundreds of tool calls with few, small snapshots and the turn totals', async () => {
		const STEPS = 300;
		const chunks = longTurn(STEPS);
		const r = await fold(chunks);
		console.log(`long task: ${chunks.length} chunks -> ${r.snapshots} snapshots in ${Math.round(r.ms)} ms`);
		expect(r.usage).toEqual({ steps: STEPS, costUsd: STEPS / 100 });
		expect(r.snapshots).toBeLessThan(chunks.length / 5);
		expect(r.ms).toBeLessThan(5_000);
		expect(r.last?.parts.filter((p) => p.type === 'tool-call_api').every((p) => isClippedPart(p))).toBe(true);
	}, 30_000);

	test('gives the same message as the plain fold, apart from the clipped payloads', async () => {
		const chunks = longTurn(8);
		const { last } = await fold(chunks);
		let plain: UIMessage | undefined;
		for await (const m of readUIMessageStream({ stream: streamOf(chunks) })) plain = m;
		expect(last?.parts.map((p) => [p.type, (p as { state?: string }).state])).toEqual(plain?.parts.map((p) => [p.type, (p as { state?: string }).state]));
		const reasoning = last?.parts.find((p) => p.type === 'reasoning') as { text: string };
		expect(reasoning.text).toBe('thinking about the data '.repeat(60));
		expect((last?.parts.at(-1) as { text: string }).text).toBe('The answer is done.');
		const input = last?.parts.find((p) => p.type === 'tool-call_api') as { input: unknown };
		expect(input.input).toEqual({ path: '/chats', page: 0 });
	});
});
