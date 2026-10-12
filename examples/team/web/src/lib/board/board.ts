import type { Task } from '../api/client';
import { queueStatus } from '../tasks/queue';

/** The columns of the board (P40 D6): the work queue to the finished work. */
export type Column = 'queued' | 'running' | 'waiting' | 'review' | 'done';
export const COLUMNS: Column[] = ['queued', 'running', 'waiting', 'review', 'done'];
export type Board = Record<Column, Task[]>;

/** Sessions that wait on an open decision of the Decision Center (a parked run still shows `running`). */
export type WaitingSessions = ReadonlySet<string>;

type ColumnInput = Pick<Task, 'status' | 'sessionId' | 'createdBy' | 'acceptedAt' | 'report'> & Partial<Pick<Task, 'deliverables' | 'review' | 'hold' | 'queue'>>;

/** Finished work of the queue that the client has not accepted yet. */
/** Failing deliverables keep a work item out of Review until they are fixed or decided. */
export const inReview = (t: Pick<Task, 'status' | 'createdBy' | 'acceptedAt' | 'report'> & Partial<Pick<Task, 'deliverables' | 'review'>>): boolean =>
	t.status === 'done' && t.review !== false && t.deliverables?.status !== 'fail' && t.createdBy !== null && t.acceptedAt === null && (t.report?.status === 'done' || t.report?.status === 'partial');

/**
 * Where a task shows. Waiting for you: an approval or question waits, or the run is parked on an open
 * decision. Review: a finished work item whose report is `done` or `partial` and that is not accepted.
 */
export function columnOf(t: ColumnInput, waiting: WaitingSessions = new Set()): Column {
	if (t.status === 'queued') return 'queued';
	if (t.status === 'needs_action' || (t.status === 'running' && waiting.has(t.sessionId))) return 'waiting';
	if (t.status === 'running') return 'running';
	if (t.deliverables?.status === 'fail' && waiting.has(t.sessionId)) return 'waiting';
	return inReview(t) ? 'review' : 'done';
}

const RANK = { low: 0, normal: 1, high: 2, urgent: 3 } as const;

/** The order the queue is taken in: priority, nearest due date, oldest. */
export function queueOrder(a: Task, b: Task): number {
	return (
		RANK[b.priority] - RANK[a.priority] ||
		(a.dueAt ?? Number.MAX_SAFE_INTEGER) - (b.dueAt ?? Number.MAX_SAFE_INTEGER) ||
		a.id.localeCompare(b.id)
	);
}

/**
 * Group tasks into the board columns. `failed` and `stopped` go to Done (the card shows a badge). Newest
 * activity first, except Queued, which is in the order a worker takes it; optional filter by agent id.
 */
export function groupBoard(tasks: readonly Task[], filter: { agentId?: string | null; waiting?: WaitingSessions } = {}): Board {
	const out: Board = { queued: [], running: [], waiting: [], review: [], done: [] };
	for (const t of tasks) {
		if (filter.agentId && t.agentId !== filter.agentId) continue;
		out[columnOf(t, filter.waiting)].push(t);
	}
	for (const c of COLUMNS) out[c].sort(c === 'queued' ? queueOrder : (a, b) => b.lastActivityAt - a.lastActivityAt);
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

type Variant = 'warning' | 'info' | 'success' | 'destructive' | 'outline' | 'secondary';

export const badgeFor = (status: Task['status'], summary?: string | null): { label: string; variant: Variant } =>
	status === 'queued'
		? { label: 'queued', variant: 'secondary' }
		: status === 'needs_action'
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

/** The badge of a task on the board: its column says more than its status. */
export function badgeOf(t: ColumnInput & Pick<Task, 'summary'>, waiting: WaitingSessions = new Set()): { label: string; variant: Variant } {
	const column = columnOf(t, waiting);
	const queued = queueStatus(t);
	if (queued !== null) return { label: queued.label, variant: t.hold || t.queue === 'hold' ? 'outline' : 'secondary' };
	if (column === 'waiting') return { label: 'waiting for you', variant: 'warning' };
	if (column === 'review') return { label: t.report?.status === 'partial' ? 'review (partial)' : 'review', variant: 'info' };
	if (column === 'done' && t.status === 'done' && t.acceptedAt !== null) return { label: 'accepted', variant: 'success' };
	return badgeFor(t.status, t.summary);
}
