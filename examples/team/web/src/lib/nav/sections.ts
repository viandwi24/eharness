// Main navigation of the app shell (icon rail on desktop, bottom bar on mobile). Pure.

export type SectionId = 'agents' | 'tasks' | 'decisions' | 'programs' | 'routines' | 'files' | 'artifacts' | 'tables' | 'channels' | 'people' | 'connectors' | 'browser' | 'developers' | 'logs' | 'audit' | 'attention' | 'settings';

export const SECTIONS: { id: SectionId; href: string; label: string }[] = [
	{ id: 'agents', href: '/', label: 'Agents' },
	{ id: 'tasks', href: '/tasks', label: 'Tasks' },
	{ id: 'decisions', href: '/decisions', label: 'Decisions' },
	{ id: 'programs', href: '/programs', label: 'Programs' },
	{ id: 'routines', href: '/routines', label: 'Reminders' },
	{ id: 'files', href: '/files', label: 'Files' },
	{ id: 'artifacts', href: '/artifacts', label: 'Artifacts' },
	{ id: 'tables', href: '/tables', label: 'Tables' },
	{ id: 'channels', href: '/channels', label: 'Channels' },
	{ id: 'people', href: '/people', label: 'People' },
	{ id: 'connectors', href: '/connectors', label: 'Connectors' },
	{ id: 'browser', href: '/browser', label: 'Browser' },
	{ id: 'developers', href: '/developers', label: 'Developers' },
	{ id: 'logs', href: '/logs', label: 'Logs' },
	{ id: 'audit', href: '/audit', label: 'Audit' },
	{ id: 'attention', href: '/attention', label: 'Needs attention' },
	{ id: 'settings', href: '/settings', label: 'Settings' }
];

/** The agent's work: one rail item, the sections are a second column (a row on a phone). */
export const WORK_SECTIONS = ['tasks', 'decisions', 'programs', 'routines'] as const satisfies readonly SectionId[];

export const isWorkSection = (id: SectionId): boolean => (WORK_SECTIONS as readonly SectionId[]).includes(id);

/** Items of the rail: the work sections are folded into one "work" item. */
export type RailId = Exclude<SectionId, (typeof WORK_SECTIONS)[number]> | 'work';

export const RAIL: { id: RailId; href: string; label: string }[] = [
	{ id: 'agents', href: '/', label: 'Agents' },
	{ id: 'work', href: '/tasks', label: 'Work' },
	...SECTIONS.filter((s) => s.id !== 'agents' && !isWorkSection(s.id)).map((s) => ({ ...s, id: s.id as RailId }))
];

/** The section a path belongs to; agent chats and the home are "agents". */
export function sectionOf(pathname: string): SectionId {
	for (const s of SECTIONS) {
		if (s.id !== 'agents' && (pathname === s.href || pathname.startsWith(`${s.href}/`))) return s.id;
	}
	return 'agents';
}

/** The rail item a path belongs to. */
export function railOf(pathname: string): RailId {
	const s = sectionOf(pathname);
	return isWorkSection(s) ? 'work' : (s as RailId);
}

/** The second column of a path: the agent list, the work menu, or none. */
export function subSidebarOf(pathname: string): 'agents' | 'work' | undefined {
	const r = railOf(pathname);
	return r === 'agents' || r === 'work' ? r : undefined;
}

export const hasSubSidebar = (pathname: string): boolean => subSidebarOf(pathname) !== undefined;
