import type { components } from '../api/schema';

export type ReminderRow = components['schemas']['ChannelReminder'];

/** What the Routines page shows: everything, only routines, only active reminders, or finished reminders. */
export type RoutineKind = 'all' | 'routines' | 'reminders' | 'finished';

export const KIND_OPTIONS: ReadonlyArray<{ value: RoutineKind; label: string }> = [
	{ value: 'all', label: 'Routines and reminders' },
	{ value: 'routines', label: 'Routines only' },
	{ value: 'reminders', label: 'Active reminders' },
	{ value: 'finished', label: 'Finished reminders' }
];

/** The badge of a reminder row: where it posts. */
export const reminderBadge = (r: Pick<ReminderRow, 'place'>): string => `Reminder · ${r.place}`;

/** The status badge of a reminder. */
export function reminderStatus(r: Pick<ReminderRow, 'status'>): { label: string; variant: 'success' | 'secondary' | 'destructive' } {
	if (r.status === 'active') return { label: 'active', variant: 'success' };
	return r.status === 'done' ? { label: 'done', variant: 'secondary' } : { label: 'cancelled', variant: 'secondary' };
}

export const showsRoutines = (kind: RoutineKind): boolean => kind === 'all' || kind === 'routines';

/** The reminders a filter shows (the server already puts active ones first, then the finished ones, newest first). */
export function remindersFor(kind: RoutineKind, reminders: readonly ReminderRow[], agentId = ''): ReminderRow[] {
	if (kind === 'routines') return [];
	return reminders.filter(
		(r) => (agentId === '' || r.agentId === agentId) && (kind === 'all' || (kind === 'finished' ? r.status !== 'active' : r.status === 'active'))
	);
}
