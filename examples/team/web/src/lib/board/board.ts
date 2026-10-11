import type { Task } from '../api/client';

export type Column = 'needs' | 'running' | 'done';
export type Board = Record<Column, Task[]>;

export const columnOf = (t: Pick<Task, 'status'>): Column =>
	t.status === 'needs_action' ? 'needs' : t.status === 'running' ? 'running' : 'done';

/**
 * Group tasks into the board columns (spec §6.4). `failed` and `stopped` go to Done (the card shows a badge).
 * Newest activity first; optional filter by agent id.
 */
export function groupBoard(tasks: readonly Task[], filter: { agentId?: string | null } = {}): Board {
	const out: Board = { needs: [], running: [], done: [] };
	for (const t of tasks) {
		if (filter.agentId && t.agentId !== filter.agentId) continue;
		out[columnOf(t)].push(t);
	}
	for (const c of Object.keys(out) as Column[]) out[c].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
	return out;
}

/** Insert or replace a task by id (events patch tasks in place). */
export function upsertTask(tasks: Task[], t: Task): Task[] {
	const i = tasks.findIndex((x) => x.id === t.id);
	if (i < 0) return [t, ...tasks];
	const next = tasks.slice();
	next[i] = t;
	return next;
}

export const badgeFor = (
	status: Task['status'],
	summary?: string | null
): { label: string; variant: 'warning' | 'info' | 'success' | 'destructive' | 'outline' } =>
	status === 'needs_action'
		? { label: 'waiting for you', variant: 'warning' }
		: status === 'running'
			? { label: 'running', variant: 'info' }
			: status === 'failed'
				? { label: summary === 'Failed to start' ? 'failed to start' : 'failed', variant: 'destructive' }
				: status === 'stopped'
					? { label: 'stopped', variant: 'outline' }
					: status === 'interrupted'
						? { label: 'interrupted', variant: 'warning' }
						: status === 'timed_out'
							? { label: 'timed out', variant: 'warning' }
							: { label: 'done', variant: 'success' };
