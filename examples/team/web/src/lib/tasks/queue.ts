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
};

export const emptyTaskForm = (agentId = ''): TaskForm => ({ agentId, title: '', brief: '', inputs: '', priority: 'normal', due: '' });

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
	return errors;
}

export function bodyFromTaskForm(f: TaskForm): TaskCreate {
	return {
		agentId: f.agentId,
		title: f.title.trim(),
		...(f.brief.trim() === '' ? {} : { brief: f.brief.trim() }),
		inputs: splitLines(f.inputs),
		priority: f.priority,
		dueAt: dueFromInput(f.due)
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
