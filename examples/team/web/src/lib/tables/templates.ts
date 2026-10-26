// Starting points of the "New table" dialog, and the names people type turned into the names the
// server accepts. Pure.
import type { ColumnType } from './tables.js';

/** A display name as a table name: `Customer contacts` → `customer_contacts`. */
export function tableSlug(display: string): string {
	const s = display
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^[^a-z]+/, '')
		.replace(/_+$/, '')
		.slice(0, 63)
		.replace(/_+$/, '');
	return s;
}

/** A typed column name as one the server accepts: `First name` → `first_name`; keeps camelCase. */
export function columnSlug(typed: string): string {
	const t = typed.trim();
	return (/\s/.test(t) ? t.toLowerCase() : t)
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^A-Za-z0-9]+/g, '_')
		.replace(/^[^A-Za-z]+/, '')
		.replace(/_+$/, '')
		.slice(0, 64);
}

/** A column of the quick builder. `default` is typed text. */
export type QuickColumn = { name: string; type: ColumnType; required: boolean; default?: string };

export type TableTemplate = { id: string; label: string; hint: string; name: string; description: string; columns: QuickColumn[] };

export const TEMPLATES: readonly TableTemplate[] = [
	{ id: 'blank', label: 'Blank', hint: 'Start empty, add fields later', name: '', description: '', columns: [{ name: 'name', type: 'string', required: false }] },
	{
		id: 'contacts',
		label: 'Contacts',
		hint: 'People, emails, companies',
		name: 'Contacts',
		description: 'People we talk to.',
		columns: [
			{ name: 'name', type: 'string', required: true },
			{ name: 'email', type: 'string', required: false },
			{ name: 'phone', type: 'string', required: false },
			{ name: 'company', type: 'string', required: false },
			{ name: 'vip', type: 'boolean', required: false, default: 'false' },
			{ name: 'notes', type: 'string', required: false }
		]
	},
	{
		id: 'tasks',
		label: 'Tasks',
		hint: 'To-dos with status and due dates',
		name: 'Tasks',
		description: 'Work to do, who does it and when.',
		columns: [
			{ name: 'title', type: 'string', required: true },
			{ name: 'status', type: 'string', required: false, default: 'todo' },
			{ name: 'assignee', type: 'string', required: false },
			{ name: 'due', type: 'date', required: false },
			{ name: 'done', type: 'boolean', required: false, default: 'false' },
			{ name: 'points', type: 'number', required: false }
		]
	},
	{
		id: 'log',
		label: 'Log',
		hint: 'Events with a time and details',
		name: 'Log',
		description: 'Things that happened, newest last.',
		columns: [
			{ name: 'event', type: 'string', required: true },
			{ name: 'level', type: 'string', required: false, default: 'info' },
			{ name: 'at', type: 'date', required: false },
			{ name: 'details', type: 'json', required: false }
		]
	}
];
