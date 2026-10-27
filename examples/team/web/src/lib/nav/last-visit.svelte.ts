// The page of each group opened last: a rail item goes back to it (Work → Decisions, Files → Artifacts, …).
import { groupOf, hasMenu, RAIL, type RailId, SECTIONS, sectionOf } from './sections.js';

const state = $state<Partial<Record<RailId, string>>>({});

export const lastVisit = {
	/** Where the rail item of a group goes: the section seen last, else the group's first one. */
	hrefOf(group: RailId): string {
		return state[group] ?? RAIL.find((r) => r.id === group)?.href ?? '/';
	},
	/** Remember the section of a path (its list page, not a detail page) in groups with a menu. */
	visit(pathname: string): void {
		const s = sectionOf(pathname);
		const g = groupOf(s);
		if (!hasMenu(g)) return;
		const href = SECTIONS.find((x) => x.id === s)?.href;
		if (href) state[g] = href;
	}
};
