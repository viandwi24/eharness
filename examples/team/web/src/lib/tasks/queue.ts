// The work queue's forms and labels. Pure.
import type { components } from '../api/schema';
import { splitLines } from '../programs/form';

export type TaskCreate = components['schemas']['TaskCreate'];
export type Priority = components['schemas']['TaskPriority'];

export const PRIORITIES: { value: Priority; label: string }[] = [
	{ value: 'low', label: 'Low' },
	{ value: 'normal', label: 'Normal' },
	{ value: 'high', label: 'High' },
	{ value: 'urgent', label: 'Urgent' }
];

export type TaskForm = {
	agentId: string;
	title: string;
	brief: string;
	/** One library path per line. */
	inputs: string;
	priority: Priority;
	/** `YYYY-MM-DD` from a date input; empty = no due date. */
	due: string;
	/** Do not start on its own: the client starts it later. */
	hold: boolean;
	/** The finished work waits in Review (default on for what the client makes). */
	review: boolean;
	/** Extra permissions for this task, one per line (optional). */
	grantTools: string;
	grantRead: string;
	grantWrite: string;
};

export const emptyTaskForm = (agentId = ''): TaskForm => ({
	agentId,
	title: '',
	brief: '',
	inputs: '',
	priority: 'normal',
	due: '',
	hold: false,
	review: true,
	grantTools: '',
	grantRead: '',
	grantWrite: ''
});

/** A date input value as the end of that day in UTC milliseconds (`null` when empty or invalid). */
export function dueFromInput(value: string): number | null {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
	const at = Date.parse(`${value}T23:59:59Z`);
	return Number.isNaN(at) ? null : at;
}

export const dueToInput = (at: number | null): string => (at === null ? '' : new Date(at).toISOString().slice(0, 10));

/** Problems the form can find without the server (field -> message). */
export function validateTaskForm(f: TaskForm): Record<string, string> {
	const errors: Record<string, string> = {};
	if (f.agentId === '') errors.agentId = 'Choose who does the task.';
	if (f.title.trim() === '') errors.title = 'Give the task a title.';
	const bad = splitLines(f.inputs).find((p) => !p.startsWith('/') || p.includes('..'));
	if (bad !== undefined) errors.inputs = `Inputs are library paths starting with /, like /library/production/videos.md (not "${bad}").`;
	if (f.due.trim() !== '' && dueFromInput(f.due) === null) errors.due = 'Pick a date.';
	for (const [field, text] of [['grantRead', f.grantRead], ['grantWrite', f.grantWrite]] as const) {
		const path = splitLines(text).find((p) => !p.startsWith('/'));
		if (path !== undefined) errors[field] = `Paths start with /, like /library/reports/** (not "${path}").`;
	}
	return errors;
}

export function bodyFromTaskForm(f: TaskForm): TaskCreate {
	const grants = { tools: splitLines(f.grantTools), read: splitLines(f.grantRead), write: splitLines(f.grantWrite) };
	const granted = grants.tools.length + grants.read.length + grants.write.length > 0;
	return {
		agentId: f.agentId,
		title: f.title.trim(),
		...(f.brief.trim() === '' ? {} : { brief: f.brief.trim() }),
		inputs: splitLines(f.inputs),
		priority: f.priority,
		dueAt: dueFromInput(f.due),
		// only what differs from the defaults is sent: it starts on its own and goes to Review
		...(f.hold ? { hold: true } : {}),
		...(f.review ? {} : { review: false }),
		...(granted ? { grants } : {})
	};
}

/** "due Nov 15" for a card; red-flag text when it is past. */
export function dueLabel(dueAt: number | null, now = Date.now()): { text: string; late: boolean } | null {
	if (dueAt === null) return null;
	const d = new Date(dueAt);
	const text = `due ${d.toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' })}`;
	return { text, late: dueAt < now };
}

export const priorityLabel = (p: Priority): string => PRIORITIES.find((o) => o.value === p)?.label ?? p;

type QueueInfo = { status: string; hold?: boolean; queue?: components['schemas']['Task']['queue'] };

/** Why a queued task has not started, in the client's words (null = it is not queued). */
export function queueStatus(t: QueueInfo): { label: string; detail: string } | null {
	if (t.status !== 'queued') return null;
	if (t.hold || t.queue === 'hold') return { label: 'on hold', detail: 'On hold: it does not start on its own. Press Start now (or release it) when you want it done.' };
	if (t.queue === 'worker') return { label: 'waits for worker', detail: 'A worker program of this agent runs its queue: it picks this up at its next run. Start now runs it right away.' };
	if (t.queue === 'slot') return { label: 'waiting for a slot', detail: 'The agent is busy with other tasks (or the team is at its limit). It starts by itself when one finishes.' };
	if (t.queue === 'starting') return { label: 'starting', detail: 'It is about to start.' };
	return { label: 'queued', detail: 'Queued: it starts by itself when its agent has a free slot.' };
}
