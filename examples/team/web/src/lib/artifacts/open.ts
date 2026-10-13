import { goto } from '$app/navigation';
import { page } from '$app/state';
import { panelSearch, type PanelTarget } from './panel.js';

/** Open (or close, with `null`) the side panel of the current page: the target goes into the URL. */
export function openPanel(target: PanelTarget | null, o: { replace?: boolean } = {}): void {
	void goto(`${page.url.pathname}${panelSearch(page.url.searchParams, target)}`, { reset: false, replace: o.replace ?? target === null });
}
