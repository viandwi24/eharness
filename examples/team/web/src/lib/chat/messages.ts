// The message list as rendered: one entry per id. The library keeps ids unique (it moves the message a
// continuation streams into to the end, `refetch` replaces the newest page), but a keyed `{#each}`
// crashes the whole page on a duplicate id (`each_key_duplicate`), so the render boundary never trusts
// that: it keeps the LAST copy of an id (the streaming one is the newest) and warns in development.
import type { FileUIPart, UIMessage } from 'ai';

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

const kindOf = (m: Pick<UIMessage, 'metadata'>): string | undefined => {
	const k = (m.metadata as { eharness?: { kind?: unknown } } | undefined)?.eharness?.kind;
	return typeof k === 'string' ? k : undefined;
};

/**
 * The assistant message Regenerate answers again: the newest reply (a kind message such as a notice
 * is not one), and only when nothing but kind messages follows it. `undefined` while there is none.
 */
export function regenerateTarget(messages: readonly UIMessage[]): UIMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as UIMessage;
		if (kindOf(m) !== undefined) continue;
		return m.role === 'assistant' ? m : undefined;
	}
	return undefined;
}

/** What Edit puts back in the box for a user message: its text and attached files. `undefined` for a message that is not the person's own input. */
export function editableInput(message: UIMessage): { text: string; files: FileUIPart[] } | undefined {
	if (message.role !== 'user' || kindOf(message) !== undefined) return undefined;
	const text = message.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n');
	const files = message.parts.filter((p): p is FileUIPart => p.type === 'file');
	if (!text.trim() && files.length === 0) return undefined;
	return { text, files };
}

/** The id of the error notice that ends the chat (nothing from the person follows it), if there is one. */
export function endingErrorNoticeId(messages: readonly UIMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as UIMessage;
		if (m.role === 'user') return undefined;
		if (kindOf(m) !== 'eh.notice') continue;
		const isError = m.parts.some((p) => p.type === 'data-eh.notice' && (p as { data?: { level?: unknown } }).data?.level === 'error');
		return isError ? m.id : undefined;
	}
	return undefined;
}

/** Whether an error notice (a failed turn, stored by the core) ends the chat: nothing from the person follows it. */
export function endsInErrorNotice(messages: readonly UIMessage[]): boolean {
	return endingErrorNoticeId(messages) !== undefined;
}
