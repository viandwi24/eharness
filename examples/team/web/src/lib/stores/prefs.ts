// Per-viewer UI preferences kept in localStorage. Every access is guarded: storage can be missing
// (SSR, tests) or throw (private windows, blocked site data), and the UI must work without it.

export function readPref(key: string): string | null {
	try {
		return globalThis.localStorage?.getItem(key) ?? null;
	} catch {
		return null;
	}
}

export function writePref(key: string, value: string): void {
	try {
		globalThis.localStorage?.setItem(key, value);
	} catch {
		// not persisted: the preference lasts for this page view only
	}
}

/** The agent panel's open state (desktop inline column). Defaults to open. */
export const PANEL_OPEN_KEY = 'team.agentPanel.open';
/** The agent panel's last tab, per agent. */
export const panelTabKey = (agentId: string): string => `team.agentPanel.tab.${agentId}`;
