// The work page opened last: the rail's "Work" item goes back to it.
import { isWorkSection, SECTIONS, sectionOf } from './sections.js';

const state = $state({ href: '/tasks' });

export const lastWork = {
	get href(): string {
		return state.href;
	},
	/** Remember the section of a work path (its list page, not a detail page). */
	visit(pathname: string): void {
		const s = sectionOf(pathname);
		if (!isWorkSection(s)) return;
		const href = SECTIONS.find((x) => x.id === s)?.href;
		if (href) state.href = href;
	}
};
