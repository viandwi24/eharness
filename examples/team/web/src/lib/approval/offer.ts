// Whether an inline approval card is offered or shown as "Already handled". The waiting list is
// fed by events and lags a streamed card by a debounce (or longer after a failed turn), so a card
// missing from the list is "handled elsewhere" only once a refresh made after the card appeared
// still does not list it. Pure, unit-tested.
import type { UIMessage } from 'ai';

export function approvalOffered(o: { listLoaded: boolean; inList: boolean; confirmedGone: boolean }): boolean {
	return !o.listLoaded || o.inList || !o.confirmedGone;
}

/** Ids of the approvals a chat shows as waiting (tool parts in `approval-requested`). */
export function requestedApprovalIds(messages: readonly UIMessage[]): string[] {
	const out: string[] = [];
	for (const m of messages) {
		if (m.role !== 'assistant') continue;
		for (const p of m.parts) {
			const part = p as { state?: unknown; approval?: { id?: unknown } };
			if (part.state === 'approval-requested' && typeof part.approval?.id === 'string') out.push(part.approval.id);
		}
	}
	return out;
}

/**
 * The chat status the UI shows. `error` is the chat object's own state after a failed request; the
 * failure is shown as a stored notice and a toast, so the composer must go back to idle (an `error`
 * status renders the red stop-like button until the next send).
 */
export function shownChatStatus<S extends string>(status: S): Exclude<S, 'error'> | 'ready' {
	return (status === 'error' ? 'ready' : status) as Exclude<S, 'error'> | 'ready';
}
