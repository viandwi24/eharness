// Pure request/response helpers for the chat (no Svelte, unit-tested).
import type { UIMessage } from 'ai';

/** `useChat` request body shape the server reads (spec 11 §7). */
export type ChatRequestBody = {
	id: string;
	messages: UIMessage[];
	trigger?: string;
	messageId?: string;
};

/** Send only the last message (plus trigger / messageId): the server never reads client history. */
export function buildChatRequest(input: {
	id: string;
	messages: UIMessage[];
	trigger?: string;
	messageId?: string;
}): { body: ChatRequestBody } {
	const body: ChatRequestBody = { id: input.id, messages: input.messages.slice(-1) };
	if (input.trigger !== undefined) body.trigger = input.trigger;
	if (input.messageId !== undefined) body.messageId = input.messageId;
	return { body };
}

export type ChatOutcome =
	| { kind: 'stream' }
	| { kind: 'steered'; inboxId?: string; target?: string }
	| { kind: 'busy'; message: string; code: string }
	| { kind: 'error'; status: number; message: string };

/** Classify the response of `POST /chat`; `body` is the parsed JSON for 202 and error statuses. */
export function classifyChatResponse(status: number, body: unknown): ChatOutcome {
	if (status === 202) {
		const b = (body ?? {}) as { inboxId?: unknown; target?: unknown };
		return {
			kind: 'steered',
			...(typeof b.inboxId === 'string' ? { inboxId: b.inboxId } : {}),
			...(typeof b.target === 'string' ? { target: b.target } : {})
		};
	}
	if (status >= 200 && status < 300) return { kind: 'stream' };
	const e = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
	const code = typeof e?.code === 'string' ? e.code : 'HTTP_ERROR';
	const message = typeof e?.message === 'string' ? e.message : `Request failed (${status})`;
	if (status === 409) return { kind: 'busy', code, message: busyText(code, message) };
	return { kind: 'error', status, message };
}

function busyText(code: string, message: string): string {
	if (code === 'EH_SESSION_BUSY') return 'The agent is busy with a turn. Try again when it finishes.';
	if (code === 'EH_SESSION_CLOSED') return 'This chat is closed.';
	return message;
}

/** A valid, empty UI message stream (`[DONE]` only): lets `useChat` finish cleanly after a 202. */
export function emptyStreamResponse(): Response {
	return new Response('data: [DONE]\n\n', {
		status: 200,
		headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' }
	});
}

/** Thrown from the transport fetch for a 409 so `onError` can toast instead of showing a chat error. */
export class ChatBusyError extends Error {
	readonly code: string;
	constructor(message: string, code: string) {
		super(message);
		this.name = 'ChatBusyError';
		this.code = code;
	}
}

export type StatsLike = { running?: boolean; activeTurn?: unknown | null };

/** A turn is running (here or on another instance): reattach on mount. */
export function shouldResume(stats: StatsLike | undefined): boolean {
	return !!stats && (stats.running === true || (stats.activeTurn !== null && stats.activeTurn !== undefined));
}

export type MessagesPage = { messages: UIMessage[]; nextBefore: string | null };

/** Prepend an older page, dropping ids already present (pages may overlap with live messages). */
export function mergeOlder(current: UIMessage[], older: UIMessage[]): UIMessage[] {
	const have = new Set(current.map((m) => m.id));
	return [...older.filter((m) => !have.has(m.id)), ...current];
}

/** Upload error text for a toast (size, type, other). */
export function uploadErrorText(status: number, body: unknown, name: string): string {
	const e = (body as { error?: { message?: unknown } } | null)?.error;
	const detail = typeof e?.message === 'string' ? `: ${e.message}` : '';
	if (status === 413) return `${name} is too large (max 10 MB)`;
	if (status === 400 || status === 415 || status === 422) return `${name} was rejected${detail}`;
	return `Could not upload ${name}${detail}`;
}

/** Replace the newest part of `current` with a freshly fetched tail page; older loaded pages stay. */
export function replaceTail(current: UIMessage[], tail: UIMessage[]): UIMessage[] {
	if (tail.length === 0) return current;
	const first = tail[0].id;
	// Ids sort by creation time (UUIDv7), so everything older than the page's first id is kept as is.
	return [...current.filter((m) => m.id < first), ...tail];
}
