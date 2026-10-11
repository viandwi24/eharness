// Pure logic of the task session view: merging the live stream (`followSessionStream` of
// `eharness/client`) with stored messages, polling decisions and the child-session -> task mapping
// (no Svelte).
import type { UIMessage } from 'ai';

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
