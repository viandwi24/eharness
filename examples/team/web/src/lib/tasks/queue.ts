// Labels of queued tasks (hand-overs and worker tasks). Pure.
import type { components } from '../api/schema';

export type Priority = components['schemas']['TaskPriority'];

export const PRIORITIES: { value: Priority; label: string }[] = [
	{ value: 'low', label: 'Low' },
	{ value: 'normal', label: 'Normal' },
	{ value: 'high', label: 'High' },
	{ value: 'urgent', label: 'Urgent' }
];

/** "due Nov 15" for a card; red-flag text when it is past. */
export function dueLabel(dueAt: number | null, now = Date.now()): { text: string; late: boolean } | null {
	if (dueAt === null) return null;
	const d = new Date(dueAt);
	const text = `due ${d.toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' })}`;
	return { text, late: dueAt < now };
}

export const priorityLabel = (p: Priority): string => PRIORITIES.find((o) => o.value === p)?.label ?? p;

type QueueInfo = { status: string; hold?: boolean; queue?: components['schemas']['Task']['queue']; queueNote?: string | null };

/**
 * Why a queued task has not started, in the client's words (null = it is not queued). `note` is the
 * server's sentence when a slot wait is held by a task that waits for the client ("waiting: <task>
 * needs your approval first"); it is also appended to `detail`.
 */
export function queueStatus(t: QueueInfo): { label: string; detail: string; note: string | null } | null {
	if (t.status !== 'queued') return null;
	const note = t.queueNote?.trim() ? t.queueNote.trim() : null;
	const out = (label: string, detail: string, withNote = false): { label: string; detail: string; note: string | null } => ({
		label,
		detail: withNote && note ? `${detail} ${note}` : detail,
		note: withNote ? note : null
	});
	if (t.hold || t.queue === 'hold') return out('on hold', 'On hold: it does not start on its own. Press Start now (or release it) when you want it done.');
	if (t.queue === 'worker') return out('waits for worker', 'A worker program of this agent runs its queue: it picks this up at its next run. Start now runs it right away.');
	if (t.queue === 'slot') return out('waiting for a slot', 'The agent is busy with other tasks (or the team is at its limit). It starts by itself when one finishes.', true);
	if (t.queue === 'starting') return out('starting', 'It is about to start.');
	return out('queued', 'Queued: it starts by itself when its agent has a free slot.');
}
