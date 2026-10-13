import type { components } from '../api/schema';

export type PersonItem = components['schemas']['PersonListItem'];
export type PersonDetail = components['schemas']['PersonDetail'];
export type PersonStatus = PersonItem['status'];
export type PersonRole = NonNullable<PersonItem['role']>;

export const PERSON_ROLES: { value: PersonRole; label: string }[] = [
	{ value: 'owner', label: 'Owner' },
	{ value: 'admin', label: 'Admin' },
	{ value: 'member', label: 'Member' },
	{ value: 'guest', label: 'Guest' }
];
export const roleName = (r: PersonItem['role']): string => (r === null ? 'Default' : (PERSON_ROLES.find((x) => x.value === r)?.label ?? r));

export const STATUSES: { value: PersonStatus; label: string; hint: string }[] = [
	{ value: 'active', label: 'Active', hint: 'Has the rights of the role.' },
	{ value: 'suspended', label: 'Suspended', hint: 'Treated as a guest everywhere.' },
	{ value: 'left', label: 'Left', hint: 'No longer on the team; a guest.' }
];

const PLATFORMS: Record<string, string> = { telegram: 'Telegram', whatsapp: 'WhatsApp', slack: 'Slack', discord: 'Discord', mock: 'Mock' };
export const platformName = (p: string): string => PLATFORMS[p] ?? p;

/** "@name" or the label of an account, for lists. */
export const accountText = (a: { platform: string; label: string | null; username: string | null }): string => `${platformName(a.platform)}${a.label ? ` (${a.label})` : a.username ? ` @${a.username}` : ''}`;

export const eventText = (e: { kind: string; detail: Record<string, unknown> }): string => {
	const keys = Object.keys(e.detail).filter((k) => k !== 'notes');
	const parts = keys.map((k) => `${k}: ${typeof e.detail[k] === 'object' ? JSON.stringify(e.detail[k]) : String(e.detail[k])}`);
	return parts.join(', ');
};
