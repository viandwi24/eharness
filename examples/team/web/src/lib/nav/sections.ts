// Main navigation of the app shell (icon rail on desktop, bottom bar on mobile). Pure.

export type SectionId = 'agents' | 'tasks' | 'briefings' | 'decisions' | 'programs' | 'routines' | 'files' | 'channels' | 'people' | 'connectors' | 'logs' | 'settings';

/** Sections that belong together are shown as one group (the agent's work, the workspace, ...). */
export type SectionGroup = 'home' | 'work' | 'workspace' | 'system';

export const GROUP_LABELS: Record<SectionGroup, string> = {
	home: 'Agents',
	work: 'Work',
	workspace: 'Workspace',
	system: 'System'
};

export const SECTIONS: { id: SectionId; href: string; label: string; group: SectionGroup }[] = [
	{ id: 'agents', href: '/', label: 'Agents', group: 'home' },
	{ id: 'tasks', href: '/tasks', label: 'Tasks', group: 'work' },
	{ id: 'briefings', href: '/briefings', label: 'Briefing', group: 'work' },
	{ id: 'decisions', href: '/decisions', label: 'Decisions', group: 'work' },
	{ id: 'programs', href: '/programs', label: 'Programs', group: 'work' },
	{ id: 'routines', href: '/routines', label: 'Routines', group: 'work' },
	{ id: 'files', href: '/files', label: 'Files', group: 'workspace' },
	{ id: 'channels', href: '/channels', label: 'Channels', group: 'workspace' },
	{ id: 'people', href: '/people', label: 'People', group: 'workspace' },
	{ id: 'connectors', href: '/connectors', label: 'Connectors', group: 'workspace' },
	{ id: 'logs', href: '/logs', label: 'Logs', group: 'system' },
	{ id: 'settings', href: '/settings', label: 'Settings', group: 'system' }
];

/** Consecutive sections of one group, in order (the rail draws a divider between groups). */
export function groupSections<T extends { group: SectionGroup }>(items: readonly T[]): { group: SectionGroup; items: T[] }[] {
	const out: { group: SectionGroup; items: T[] }[] = [];
	for (const s of items) {
		const last = out.at(-1);
		if (last && last.group === s.group) last.items.push(s);
		else out.push({ group: s.group, items: [s] });
	}
	return out;
}

/** The section a path belongs to; agent chats and the home are "agents". */
export function sectionOf(pathname: string): SectionId {
	for (const s of SECTIONS) {
		if (s.id !== 'agents' && (pathname === s.href || pathname.startsWith(`${s.href}/`))) return s.id;
	}
	return 'agents';
}

/** Only the agents section has a second column (the agent list). */
export const hasSubSidebar = (pathname: string): boolean => sectionOf(pathname) === 'agents';
