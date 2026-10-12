// Helpers for the approvals of a chat. The waiting list is fed by events and lags a streamed tool
// row by a debounce (or longer after a failed turn); see `standingOf` in chip.ts. Pure, unit-tested.
import type { UIMessage } from 'ai';

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
