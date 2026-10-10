// Main navigation of the app shell (icon rail on desktop, bottom bar on mobile). Pure.

export type SectionId = 'agents' | 'tasks' | 'routines' | 'files' | 'logs' | 'settings';

export const SECTIONS: { id: SectionId; href: string; label: string }[] = [
	{ id: 'agents', href: '/', label: 'Agents' },
	{ id: 'tasks', href: '/tasks', label: 'Tasks' },
	{ id: 'routines', href: '/routines', label: 'Routines' },
	{ id: 'files', href: '/files', label: 'Files' },
	{ id: 'logs', href: '/logs', label: 'Logs' },
	{ id: 'settings', href: '/settings', label: 'Settings' }
];

/** The section a path belongs to; agent chats and the home are "agents". */
export function sectionOf(pathname: string): SectionId {
	for (const s of SECTIONS) {
		if (s.id !== 'agents' && (pathname === s.href || pathname.startsWith(`${s.href}/`))) return s.id;
	}
	return 'agents';
}

/** Only the agents section has a second column (the agent list). */
export const hasSubSidebar = (pathname: string): boolean => sectionOf(pathname) === 'agents';
