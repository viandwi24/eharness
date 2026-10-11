// The message list as rendered: one entry per id. The library keeps ids unique (it moves the message a
// continuation streams into to the end, `refetch` replaces the newest page), but a keyed `{#each}`
// crashes the whole page on a duplicate id (`each_key_duplicate`), so the render boundary never trusts
// that: it keeps the LAST copy of an id (the streaming one is the newest) and warns in development.
import type { UIMessage } from 'ai';

/** `messages` without repeated ids (the last copy wins, at its place). Returns the same array when there are none. */
export function uniqueById<M extends Pick<UIMessage, 'id'>>(messages: readonly M[], onDuplicate?: (id: string) => void): readonly M[] {
	const last = new Map<string, number>();
	messages.forEach((m, i) => last.set(m.id, i));
	if (last.size === messages.length) return messages;
	const out: M[] = [];
	messages.forEach((m, i) => {
		if (last.get(m.id) === i) out.push(m);
		else onDuplicate?.(m.id);
	});
	return out;
}

/**
 * An assistant message with nothing to show: no parts, or only step markers and empty text. A
 * provider failure stores one on purpose (spec 05 §3) next to the `eh.notice`; the chat hides it.
 */
export function isEmptyAssistant(message: Pick<UIMessage, 'role' | 'parts'>): boolean {
	if (message.role !== 'assistant') return false;
	return message.parts.every((p) => p.type === 'step-start' || (p.type === 'text' && p.text.trim() === ''));
}

/** `messages` without the empty assistant messages. Returns the same array when there are none. */
export function withoutEmptyAssistant<M extends Pick<UIMessage, 'role' | 'parts'>>(messages: readonly M[]): readonly M[] {
	return messages.some(isEmptyAssistant) ? messages.filter((m) => !isEmptyAssistant(m)) : messages;
}
