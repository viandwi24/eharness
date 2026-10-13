import { api } from '../api/index';
import { setTeamZone } from '../time';

/**
 * The team timezone as the UI knows it (`lib/time.ts`). `rev` changes when the zone changes, so the
 * layout re-renders the page and every time on screen follows (startup, or a save in Settings).
 */
export const teamClock = $state({ rev: 0 });

/** Apply a zone from the server; re-render when it differs from what was shown. */
export function applyTeamZone(tz: string): void {
	if (setTeamZone(tz)) teamClock.rev++;
}

/** Read the team timezone from `/settings`. Never throws: the cached zone stays on failure. */
export async function loadTeamZone(): Promise<void> {
	try {
		applyTeamZone((await api.get('/settings')).timezone);
	} catch {
		// offline or signed out: keep the last known zone
	}
}
