/** Pure helpers of the subagent card: the child session id and the live status. */
import type { SubagentStatus } from './map.js';

type TaskLike = { status: 'needs_action' | 'running' | 'done' | 'failed' | 'stopped' | 'interrupted' | 'timed_out'; summary?: string | null };
type TaskRow = TaskLike & { sessionId: string };

/**
 * The child session id of an `agent` call: the `data-subagent.run` marker (stored for every call,
 * foreground and background), else the one a background start names in its result text
 * (`Started background subagent <child session id> ...`, spec 20 §3.5).
 */
export function childSessionOf(run: { sessionId?: string } | undefined, output: unknown): string | undefined {
	if (run?.sessionId) return run.sessionId;
	if (typeof output !== 'string') return undefined;
	return /^Started background subagent (\S+)/.exec(output)?.[1];
}

/** Card status word of a task row (the child's own turns decide it, kept live by the events). */
export function taskStatusWord(task: TaskLike | undefined): SubagentStatus | undefined {
	switch (task?.status) {
		case 'needs_action':
			return 'waiting';
		case 'running':
			return 'running';
		case 'done':
			return 'completed';
		case 'failed':
			return task.summary === 'Failed to start' ? 'not_started' : 'failed';
		case 'interrupted':
			return 'interrupted';
		case 'timed_out':
			return 'timed_out';
		case 'stopped':
			return 'stopped';
		default:
			return undefined;
	}
}

/** The stored marker says what it was at the start; the task row says what it is now. */
export function cardStatus(stored: SubagentStatus, task: TaskLike | undefined): SubagentStatus {
	return taskStatusWord(task) ?? stored;
}

/**
 * The task row of an `agent` call. By the child session id when it is known; otherwise (calls
 * stored without a marker, e.g. cancelled before ADR-0046) the task whose child session the task
 * index registered for this tool call (`…:agent:<toolCallId>`).
 */
export function taskOfCall<T extends TaskRow>(tasks: readonly T[], sessionId: string | undefined, toolCallId: string | undefined): T | undefined {
	if (sessionId) return tasks.find((t) => t.sessionId === sessionId);
	if (!toolCallId) return undefined;
	return tasks.find((t) => t.sessionId.endsWith(`:agent:${toolCallId}`));
}

/** Words on the card badge. */
export const STATUS_LABEL: Record<SubagentStatus, string> = {
	running: 'running',
	waiting: 'waiting for you',
	completed: 'completed',
	failed: 'failed',
	stopped: 'stopped',
	interrupted: 'interrupted',
	timed_out: 'timed out',
	not_started: 'failed to start'
};

/** A child the person can continue (it stopped without finishing its work). */
export const canContinue = (status: SubagentStatus): boolean => status === 'interrupted' || status === 'timed_out' || status === 'not_started' || status === 'failed' || status === 'stopped';
