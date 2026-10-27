// Main navigation of the app shell (icon rail on desktop, bottom bar on mobile). Pure.

export type SectionId = 'agents' | 'tasks' | 'decisions' | 'programs' | 'routines' | 'files' | 'artifacts' | 'tables' | 'scripts' | 'channels' | 'people' | 'connectors' | 'browser' | 'developers' | 'logs' | 'audit' | 'attention' | 'settings';

export const SECTIONS: { id: SectionId; href: string; label: string; hint: string }[] = [
	{ id: 'agents', href: '/', label: 'Agents', hint: 'Chat with your agents' },
	{ id: 'tasks', href: '/tasks', label: 'Tasks', hint: 'Work the agents do' },
	{ id: 'decisions', href: '/decisions', label: 'Decisions', hint: 'Questions waiting for you' },
	{ id: 'attention', href: '/attention', label: 'Needs attention', hint: 'What is stuck or failing' },
	{ id: 'programs', href: '/programs', label: 'Programs', hint: 'Standing orders' },
	{ id: 'routines', href: '/routines', label: 'Reminders', hint: 'Reminders you set' },
	{ id: 'audit', href: '/audit', label: 'Audit', hint: 'Who did what, and when' },
	{ id: 'files', href: '/files', label: 'Files', hint: 'The shared library' },
	{ id: 'artifacts', href: '/artifacts', label: 'Artifacts', hint: 'Pages and documents the agents made' },
	{ id: 'connectors', href: '/connectors', label: 'Connectors', hint: 'Apps and services the agents use' },
	{ id: 'channels', href: '/channels', label: 'Channels', hint: 'Chat platforms and their chats' },
	{ id: 'people', href: '/people', label: 'People', hint: 'Who the agents talk to' },
	{ id: 'browser', href: '/browser', label: 'Browser', hint: 'Browsers your agents use' },
	{ id: 'tables', href: '/tables', label: 'Tables', hint: 'Lists and records' },
	{ id: 'scripts', href: '/scripts', label: 'Scripts', hint: 'Small programs on chat events' },
	{ id: 'logs', href: '/logs', label: 'Logs', hint: 'What happened, step by step' },
	{ id: 'settings', href: '/settings', label: 'Settings', hint: 'The workspace' },
	{ id: 'developers', href: '/developers', label: 'Developers', hint: 'Let other applications call agents' }
];

/** Items of the rail. A group of more than one section gets its own menu (a second column). */
export type RailId = 'agents' | 'work' | 'files' | 'connectors' | 'channels' | 'tools' | 'logs' | 'settings';

/** `home`: the section the rail item opens first (default: the first one). */
export const GROUPS: { id: RailId; label: string; sections: readonly SectionId[]; home?: SectionId }[] = [
	{ id: 'agents', label: 'Agents', sections: ['agents'] },
	{ id: 'work', label: 'Work', sections: ['tasks', 'decisions', 'attention', 'programs', 'routines', 'audit'] },
	{ id: 'files', label: 'Files', sections: ['files', 'artifacts'] },
	{ id: 'connectors', label: 'Connectors', sections: ['connectors'] },
	{ id: 'channels', label: 'Channels', sections: ['channels', 'people'] },
	{ id: 'tools', label: 'Tools', sections: ['browser', 'tables', 'scripts'], home: 'tables' }, // Browser shows only once set up
	{ id: 'logs', label: 'Logs', sections: ['logs'] },
	{ id: 'settings', label: 'Settings', sections: ['settings', 'developers'] }
];

const sectionById = (id: SectionId): (typeof SECTIONS)[number] => SECTIONS.find((s) => s.id === id)!;

/** The sections of a group, in menu order. */
export const sectionsOf = (group: RailId): (typeof SECTIONS)[number][] => (GROUPS.find((g) => g.id === group)?.sections ?? []).map(sectionById);

/** A rail item opens the home section of its group (the rail may remember a later one). */
export const RAIL: { id: RailId; href: string; label: string }[] = GROUPS.map((g) => ({ id: g.id, label: g.label, href: sectionById(g.home ?? g.sections[0]!).href }));

/** The section a path belongs to; agent chats and the home are "agents". */
export function sectionOf(pathname: string): SectionId {
	for (const s of SECTIONS) {
		if (s.id !== 'agents' && (pathname === s.href || pathname.startsWith(`${s.href}/`))) return s.id;
	}
	return 'agents';
}

/** The group a section belongs to. */
export function groupOf(id: SectionId): RailId {
	return GROUPS.find((g) => g.sections.includes(id))?.id ?? 'agents';
}

/** The rail item a path belongs to. */
export function railOf(pathname: string): RailId {
	return groupOf(sectionOf(pathname));
}

/** A group with a menu of its own: more than one section. */
export const hasMenu = (group: RailId): boolean => (GROUPS.find((g) => g.id === group)?.sections.length ?? 0) > 1;

/** The second column of a path: the agent list, the menu of its group, or none. */
export function subSidebarOf(pathname: string): RailId | undefined {
	const r = railOf(pathname);
	return r === 'agents' || hasMenu(r) ? r : undefined;
}

export const hasSubSidebar = (pathname: string): boolean => subSidebarOf(pathname) !== undefined;
