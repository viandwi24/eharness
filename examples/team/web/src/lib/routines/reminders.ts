import type { components } from '../api/schema';

export type ReminderRow = components['schemas']['ChannelReminder'];

/** What the Reminders page shows: active reminders, finished ones, or both. */
export type ReminderFilter = 'active' | 'finished' | 'all';

export const FILTER_OPTIONS: ReadonlyArray<{ value: ReminderFilter; label: string }> = [
	{ value: 'active', label: 'Active reminders' },
	{ value: 'finished', label: 'Finished reminders' },
	{ value: 'all', label: 'All reminders' }
];

/** The badge of a reminder row: where it posts. */
export const reminderBadge = (r: Pick<ReminderRow, 'place'>): string => `Reminder · ${r.place}`;

/** The status badge of a reminder. */
export function reminderStatus(r: Pick<ReminderRow, 'status'>): { label: string; variant: 'success' | 'secondary' | 'destructive' } {
	if (r.status === 'active') return { label: 'active', variant: 'success' };
	return r.status === 'done' ? { label: 'done', variant: 'secondary' } : { label: 'cancelled', variant: 'secondary' };
}

/** The reminders a filter shows (the server already puts active ones first, then the finished ones, newest first). */
export function remindersFor(filter: ReminderFilter, reminders: readonly ReminderRow[], agentId = ''): ReminderRow[] {
	return reminders.filter(
		(r) => (agentId === '' || r.agentId === agentId) && (filter === 'all' || (filter === 'finished' ? r.status !== 'active' : r.status === 'active'))
	);
}
