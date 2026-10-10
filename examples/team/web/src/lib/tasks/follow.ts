// Pure logic of the task session view: following the child session's live stream, merging it
// with stored messages, polling decisions and the child-session -> task mapping (no Svelte).
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';

/** Task statuses the stored transcript keeps changing in (a turn runs or may start). */
export function isLive(status: string | undefined): boolean {
	return status === 'running';
}

/** Poll delay (ms) of `GET /tasks/{id}`; `null` = do not poll. Streaming replaces polling. */
export function pollDelay(input: { status: string | undefined; streaming: boolean; visible?: boolean }): number | null {
	if (!isLive(input.status) || input.streaming) return null;
	return input.visible === false ? 5000 : 1000;
}

/** Child session id -> task id (the board index). */
export function taskIdOfSession(tasks: { id: string; sessionId: string }[], sessionId: string): string | undefined {
	return tasks.find((t) => t.sessionId === sessionId)?.id;
}

/** Replace the message with the same id, or append (stored order stays; ids sort by time). */
export function upsertMessage<M extends { id: string }>(list: M[], message: M): M[] {
	const i = list.findIndex((m) => m.id === message.id);
	if (i === -1) return [...list, message];
	const next = list.slice();
	next[i] = message;
	return next;
}

/** Stored messages with the live (streaming) ones laid over them by id. */
export function mergeLive(stored: UIMessage[], live: Map<string, UIMessage>): UIMessage[] {
	let out = stored;
	for (const m of live.values()) out = upsertMessage(out, m);
	return out;
}

/** Parse an SSE body (`data: <json>` events) into UI message chunks; `[DONE]` ends it. */
export function parseChunkStream(body: ReadableStream<Uint8Array>): ReadableStream<UIMessageChunk> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	const queue: UIMessageChunk[] = [];
	const take = (final: boolean): boolean => {
		let done = false;
		while (true) {
			const end = buffer.indexOf('\n\n');
			if (end === -1 && !(final && buffer.trim() !== '')) break;
			const raw = end === -1 ? buffer : buffer.slice(0, end);
			buffer = end === -1 ? '' : buffer.slice(end + 2);
			const data = raw
				.split('\n')
				.filter((l) => l.startsWith('data:'))
				.map((l) => l.slice(5).trimStart())
				.join('\n');
			if (data === '') continue;
			if (data === '[DONE]') {
				done = true;
				break;
			}
			try {
				queue.push(JSON.parse(data) as UIMessageChunk);
			} catch {
				// a damaged event is skipped; the stored messages are refetched at the end anyway
			}
		}
		return done;
	};
	return new ReadableStream<UIMessageChunk>({
		async pull(controller) {
			while (true) {
				const next = queue.shift();
				if (next !== undefined) return controller.enqueue(next);
				const { done, value } = await reader.read();
				if (done) {
					take(true);
					const last = queue.shift();
					if (last !== undefined) return controller.enqueue(last);
					return controller.close();
				}
				buffer += decoder.decode(value, { stream: true });
				if (take(false)) {
					const last = queue.shift();
					if (last !== undefined) controller.enqueue(last);
					else controller.close();
					await reader.cancel().catch(() => {});
					return;
				}
			}
		},
		cancel: (reason) => reader.cancel(reason)
	});
}

export type FollowResult = 'streamed' | 'idle' | 'error';

/**
 * Follow the active turn of a task session. `204` (nothing streams) is `idle`. Every state of the
 * message being built goes to `onMessage`. The server replays the whole message first, also for a
 * `respond()` continuation (spec 04 §6.3), so the chunks apply to a full message.
 */
export async function followTaskStream(options: {
	url: string;
	fetch: (url: string, init?: RequestInit) => Promise<Response>;
	headers?: Record<string, string>;
	signal?: AbortSignal;
	onMessage: (message: UIMessage) => void;
}): Promise<FollowResult> {
	let res: Response;
	try {
		res = await options.fetch(options.url, {
			headers: { accept: 'text/event-stream', ...options.headers },
			...(options.signal ? { signal: options.signal } : {})
		});
	} catch {
		return 'error';
	}
	if (res.status === 204 || res.body === null) return 'idle';
	if (!res.ok) return 'error';
	try {
		const chunks = parseChunkStream(res.body);
		for await (const message of readUIMessageStream({ stream: chunks, onError: () => {} })) {
			options.onMessage(message);
		}
		return 'streamed';
	} catch {
		return 'error';
	}
}
