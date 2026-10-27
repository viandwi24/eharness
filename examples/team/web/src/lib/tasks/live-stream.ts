// Live stream of a task session for the task panel. `followSessionStream` of `eharness/client`
// hands over a full copy of the message for every chunk (AI SDK `readUIMessageStream` snapshots
// it); on a long task (hundreds of steps, the server replays the whole turn on connect) that is
// tens of thousands of copies of a megabyte-sized message and the tab freezes. Here the chunks are
// trimmed before the SDK folds them: consecutive text/reasoning deltas are merged and big tool
// payloads are clipped like the stored pages (`?clip=`). Pure apart from the transport; tested.
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import { createHarnessTransport, type HarnessClient } from 'eharness/client';

/** Turn totals of the transient `data-eh.usage` chunk (cumulative for the running turn). */
export type TurnUsage = { steps: number; costUsd?: number };

type Chunk = UIMessageChunk;
type Delta = Extract<Chunk, { type: 'text-delta' | 'reasoning-delta' }>;

const isDelta = (c: Chunk): c is Delta => c.type === 'text-delta' || c.type === 'reasoning-delta';

/**
 * Merge consecutive `text-delta` / `reasoning-delta` chunks of the same part. A held delta goes out
 * with the next other chunk, after `holdMs`, or at the end, so the text still streams live.
 */
export function coalesceDeltas(holdMs = 50): TransformStream<Chunk, Chunk> {
	let held: Delta | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const release = (controller: TransformStreamDefaultController<Chunk>): void => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
		if (held === undefined) return;
		const out = held;
		held = undefined;
		controller.enqueue(out);
	};
	return new TransformStream<Chunk, Chunk>({
		transform(chunk, controller) {
			if (isDelta(chunk)) {
				if (held !== undefined && held.type === chunk.type && held.id === chunk.id) {
					held = { ...held, delta: held.delta + chunk.delta };
					return;
				}
				release(controller);
				held = { ...chunk };
				timer = setTimeout(() => {
					try {
						release(controller);
					} catch {
						// the stream was closed or cancelled meanwhile
					}
				}, holdMs);
				return;
			}
			release(controller);
			controller.enqueue(chunk);
		},
		flush(controller) {
			release(controller);
		}
	});
}

/** The `?clip=` preview shape of the server (`isClippedPart` tells it), or undefined when small. */
function clipValue(value: unknown, clip: number): unknown {
	if (value === undefined || value === null) return undefined;
	let text: string;
	try {
		text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
	} catch {
		return undefined;
	}
	const size = typeof value === 'string' ? JSON.stringify(value).length : text.length;
	if (size <= clip) return undefined;
	return { eharnessClipped: true, chars: text.length, preview: text.slice(0, clip) };
}

/** Clip big tool inputs/outputs and data payloads of one chunk (the same chunk when nothing is over). */
export function clipChunk(chunk: Chunk, clip: number): Chunk {
	if (chunk.type === 'tool-output-available') {
		const output = clipValue(chunk.output, clip);
		return output === undefined ? chunk : { ...chunk, output };
	}
	if (chunk.type === 'tool-input-available') {
		const input = clipValue(chunk.input, clip);
		return input === undefined ? chunk : { ...chunk, input };
	}
	if (chunk.type.startsWith('data-') && !(chunk as { transient?: boolean }).transient) {
		const data = clipValue((chunk as { data?: unknown }).data, clip);
		return data === undefined ? chunk : ({ ...chunk, data } as Chunk);
	}
	return chunk;
}

/** The turn totals a `data-eh.usage` chunk carries, else undefined. */
export function usageOf(chunk: Chunk): TurnUsage | undefined {
	if (chunk.type !== 'data-eh.usage') return undefined;
	const d = (chunk as { data?: { steps?: unknown; costUsd?: unknown } }).data;
	if (typeof d?.steps !== 'number') return undefined;
	return typeof d.costUsd === 'number' ? { steps: d.steps, costUsd: d.costUsd } : { steps: d.steps };
}

export type FoldOptions = {
	/** Characters of JSON over which a tool input/output or data payload is clipped (default 2000). */
	clip?: number;
	/** How long a text/reasoning delta may wait for the next one (ms, default 50). */
	holdMs?: number;
	/** Every state of the message (a fresh copy from the SDK: safe to keep, no clone needed). */
	onMessage?: (message: UIMessage) => void;
	/** The turn totals, every time the server reports them (after each step). */
	onUsage?: (usage: TurnUsage) => void;
};

/** Fold a chunk stream into messages, trimmed as described at the top. */
export async function foldTaskStream(stream: ReadableStream<Chunk>, options: FoldOptions = {}): Promise<void> {
	const clip = options.clip ?? 2000;
	const trimmed = stream
		.pipeThrough(
			new TransformStream<Chunk, Chunk>({
				transform(chunk, controller) {
					const usage = usageOf(chunk);
					if (usage) options.onUsage?.(usage);
					controller.enqueue(clipChunk(chunk, clip));
				}
			})
		)
		.pipeThrough(coalesceDeltas(options.holdMs));
	for await (const message of readUIMessageStream({ stream: trimmed, onError: () => {} })) {
		options.onMessage?.(message);
	}
}

/**
 * Follow the active turn of a task session (`GET /sessions/{id}/chat/stream`), like
 * `followSessionStream`: `idle` = nothing streams; never throws (failures and an abort give `error`).
 */
export async function followTaskStream(
	client: HarnessClient,
	sessionId: string,
	options: FoldOptions & { signal?: AbortSignal } = {}
): Promise<'streamed' | 'idle' | 'error'> {
	try {
		const transport = createHarnessTransport({ client });
		const stream = await transport.reconnectToStream({
			chatId: sessionId,
			...(options.signal === undefined ? {} : { abortSignal: options.signal })
		});
		if (stream === null) return 'idle';
		await foldTaskStream(stream, options);
		return 'streamed';
	} catch {
		return 'error';
	}
}
