// How a chat failure reaches the person (pure, unit-tested). Failures of a turn this tab did not
// start (a subagent report woke the agent, a routine, another tab: `follow()`) are an inline banner
// with a clear sentence and, where it helps, a Retry; a message the person just sent keeps the
// compact toast. A stale answer (the item was answered elsewhere) is never an error.

export type ChatProblem = {
	message: string;
	/** What Retry does; `null` = nothing to retry (answer the waiting item, or dismiss). */
	retry: 'follow' | null;
};

const MAX = 220;

const clip = (text: string): string => (text.length > MAX ? `${text.slice(0, MAX - 1)}…` : text);

/**
 * The problem to show for `error`, or `null` when it is not worth showing (an answer to an item
 * that is not waiting any more). `serverTurn`: the failed request was a follow of a turn the
 * server started (Retry re-attaches).
 */
export function describeChatError(error: unknown, serverTurn: boolean): ChatProblem | null {
	const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
	const code = (error as { code?: unknown } | null)?.code;
	if (code === 'ALREADY_ANSWERED') return null;
	if (/still unanswered|waiting for (an|your) answer|are waiting/i.test(text)) {
		return { message: 'A question or approval in this chat is waiting for your answer. Answer it first, then continue.', retry: null };
	}
	if (code === 'EH_SESSION_BUSY' || /busy with a turn|locked by another instance|already running/i.test(text)) {
		return { message: 'The agent is busy with another turn. It will show here when it finishes.', retry: serverTurn ? 'follow' : null };
	}
	if (error instanceof TypeError || /failed to fetch|network|load failed|cannot reach/i.test(text)) {
		return { message: 'Cannot reach the server. Check your connection.', retry: serverTurn ? 'follow' : null };
	}
	const message = text.trim() ? clip(text.trim()) : 'Something went wrong while following the agent.';
	return { message, retry: serverTurn ? 'follow' : null };
}
