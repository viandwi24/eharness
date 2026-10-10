/** Pure helpers of the subagent card: the child session id and the live status. */
import type { SubagentRun } from './map.js';

type TaskLike = { status: 'needs_action' | 'running' | 'done' | 'failed' | 'stopped' };

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
export function taskStatusWord(task: TaskLike | undefined): SubagentRun['status'] | undefined {
	switch (task?.status) {
		case 'needs_action':
			return 'waiting';
		case 'running':
			return 'running';
		case 'done':
			return 'completed';
		case 'failed':
			return 'failed';
		case 'stopped':
			return 'stopped';
		default:
			return undefined;
	}
}

/** The stored marker says what it was at the start; the task row says what it is now. */
export function cardStatus(stored: SubagentRun['status'], task: TaskLike | undefined): SubagentRun['status'] {
	return taskStatusWord(task) ?? stored;
}
