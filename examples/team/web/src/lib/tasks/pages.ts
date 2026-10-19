// Paged transcript of a task session: the newest page is refreshed while the task runs, older
// pages stay loaded (merged by id; ids sort by creation time). Pure, unit-tested.
import type { UIMessage } from 'ai';

export type PageState = {
	/** Oldest first. */
	messages: UIMessage[];
	/** The history reaches further back than `messages`. */
	hasOlder: boolean;
};

export const emptyPages = (): PageState => ({ messages: [], hasOlder: false });

/**
 * The refreshed newest page laid over what is loaded: older loaded pages stay, messages of the page
 * replace their stored copies. A message the reader loaded in full (`full`) keeps its full copy while
 * its parts did not change in number. When the page does not touch the loaded range (more than a page
 * arrived while away) the old pages are dropped, as they would leave a hole.
 */
export function mergeNewest(
	state: PageState,
	newest: readonly UIMessage[],
	newestHasOlder: boolean,
	full: ReadonlySet<string> = new Set()
): PageState {
	if (state.messages.length === 0 || newest.length === 0) {
		return newest.length === 0 && state.messages.length > 0 ? state : { messages: [...newest], hasOlder: newestHasOlder };
	}
	const first = newest[0]!.id;
	const lastLoaded = state.messages[state.messages.length - 1]!.id;
	// the page starts after everything loaded and shares nothing with it: a gap
	const shared = state.messages.some((m) => newest.some((n) => n.id === m.id));
	if (!shared && first > lastLoaded && newestHasOlder) return { messages: [...newest], hasOlder: true };
	const kept = state.messages.filter((m) => m.id < first);
	const byId = new Map(state.messages.map((m) => [m.id, m]));
	const next = newest.map((n) => {
		const prev = byId.get(n.id);
		return prev && full.has(n.id) && prev.parts.length === n.parts.length ? prev : n;
	});
	return { messages: [...kept, ...next], hasOlder: state.hasOlder };
}

/** An older page (oldest first) put in front; messages already loaded are not duplicated. */
export function prependOlder(state: PageState, older: readonly UIMessage[], olderHasMore: boolean): PageState {
	const have = new Set(state.messages.map((m) => m.id));
	return { messages: [...older.filter((m) => !have.has(m.id)), ...state.messages], hasOlder: olderHasMore };
}

/** Replace the message with the same id (a full copy of a clipped one); the list is unchanged when absent. */
export function replaceMessage(state: PageState, message: UIMessage): PageState {
	if (!state.messages.some((m) => m.id === message.id)) return state;
	return { ...state, messages: state.messages.map((m) => (m.id === message.id ? message : m)) };
}
