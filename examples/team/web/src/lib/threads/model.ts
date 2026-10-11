// Chat threads as the web shows them (P40 phase M). Pure: no network, no Svelte.
import type { Thread } from '../api/client';
import { stripMarkdown } from '../format';

export const NEW_CHAT_TITLE = 'New chat';

/** What the list shows for a thread: its name, else the last words, else "New chat". */
export function threadTitle(t: Pick<Thread, 'title' | 'preview'>): string {
	const title = t.title?.trim();
	if (title) return title;
	const preview = stripMarkdown(t.preview);
	return preview ? (preview.length > 48 ? `${preview.slice(0, 47)}…` : preview) : NEW_CHAT_TITLE;
}

/** Badge text for a conversation that does not come from the web chat (a channel); null for the web. */
export function threadSourceBadge(t: Pick<Thread, 'source' | 'sourceLabel'>): string | null {
	if (t.source === 'web') return null;
	return t.sourceLabel?.trim() || 'Channel';
}

/** What the badge of a channel conversation means (tooltip): where it lives and that web messages stay here. */
export function threadSourceHint(badge: string): string {
	return `Conversation from ${badge}. You can read it and continue it here; what you write here is not posted to the chat.`;
}

/**
 * The thread to show: the one asked for when it exists, else the newest web thread (a busy channel
 * conversation must not take over the web chat; the server's default does the same), else the first.
 */
export function pickThread<T extends Pick<Thread, 'id' | 'sessionId'> & { source?: Thread['source'] }>(
	threads: readonly T[],
	wanted: string | null | undefined
): T | undefined {
	// a link may name the thread by its id or by its session id (a decision or a log row knows only that)
	return threads.find((t) => t.id === wanted || t.sessionId === wanted) ?? threads.find((t) => t.source !== 'channel') ?? threads[0];
}

/** Link to the chat thread of a session id (`dm:…` or `chat:…`), or undefined for any other session. */
export function chatHref(sessionId: string): string | undefined {
	const agent = chatSessionAgent(sessionId);
	return agent === undefined ? undefined : `/a/${agent}?t=${encodeURIComponent(sessionId)}`;
}

export const threadHref = (agentId: string, threadId: string): string => `/a/${agentId}?t=${encodeURIComponent(threadId)}`;

/** Open threads first, archived ones apart; the server order (newest activity) is kept inside each. */
export function splitThreads<T extends Pick<Thread, 'archivedAt'>>(threads: readonly T[]): { open: T[]; archived: T[] } {
	return { open: threads.filter((t) => t.archivedAt === null), archived: threads.filter((t) => t.archivedAt !== null) };
}

/**
 * The agent of a chat thread session (`dm:<agentId>` or `chat:<agentId>:<threadId>`); undefined for
 * any other session, including the child sessions of delegations (`<thread session>:agent:<call>`).
 */
export function chatSessionAgent(sessionId: string | null | undefined): string | undefined {
	if (!sessionId) return undefined;
	const dm = /^dm:([^:]+)$/.exec(sessionId);
	if (dm) return dm[1];
	return /^chat:([^:]+):[^:]+$/.exec(sessionId)?.[1];
}

/** Whether an approval's session is this thread's own session or a child of it. */
export const belongsToThread = (sessionId: string, threadSession: string): boolean => sessionId === threadSession || sessionId.startsWith(`${threadSession}:`);

/** A thread name from a text typed in the rename box; null when it is blank. */
export function cleanTitle(raw: string): string | null {
	const t = raw.replace(/\s+/g, ' ').trim().slice(0, 80);
	return t === '' ? null : t;
}
