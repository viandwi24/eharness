import { readPref, writePref } from './stores/prefs';

// One clock for the whole app: every date and time on screen is shown in the team timezone
// (Settings → Team timezone), the zone the server schedules routines and reminders in and the
// agents read. Never the browser's zone. The last known zone is cached so the first paint is right.

const ZONE_KEY = 'team.timezone';

const isZone = (tz: string): boolean => {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: tz });
		return true;
	} catch {
		return false;
	}
};

const browserZone = (): string => {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	} catch {
		return 'UTC';
	}
};

let zone: string | undefined;

/** The team timezone (IANA): the server setting once loaded, else the cached one, else the browser's. */
export function teamZone(): string {
	if (zone === undefined) {
		const cached = readPref(ZONE_KEY);
		zone = cached !== null && isZone(cached) ? cached : browserZone();
	}
	return zone;
}

/** Use `tz` for every date shown from now on; true when it changed. An unknown zone is ignored. */
export function setTeamZone(tz: string): boolean {
	if (!isZone(tz) || tz === teamZone()) return false;
	zone = tz;
	writePref(ZONE_KEY, tz);
	return true;
}

/** `Intl` options with the team timezone (an explicit `timeZone` in `o` wins). */
export const zoned = (o: Intl.DateTimeFormatOptions = {}): Intl.DateTimeFormatOptions => ({ timeZone: teamZone(), ...o });

/** `toLocaleString` in the team timezone (default: medium date, short time). */
export const formatDateTime = (ms: number, o: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }): string =>
	new Date(ms).toLocaleString([], zoned(o));

/** `toLocaleDateString` in the team timezone. */
export const formatDate = (ms: number, o: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }): string =>
	new Date(ms).toLocaleDateString([], zoned(o));

/** `HH:MM` in the team timezone. */
export const formatClock = (ms: number): string => new Date(ms).toLocaleTimeString([], zoned({ hour: '2-digit', minute: '2-digit' }));

/** The wall clock of an instant in the team timezone (or `tz`). */
export function wallClock(ms: number, tz: string = teamZone()): { year: number; month: number; day: number; hour: number; minute: number } {
	const p = Object.fromEntries(
		new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
			.formatToParts(new Date(ms))
			.map((x) => [x.type, x.value])
	);
	return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour), minute: Number(p.minute) };
}

/** Calendar day number of an instant in the team timezone (for "today" / "yesterday"). */
export function dayNumber(ms: number, tz: string = teamZone()): number {
	const w = wallClock(ms, tz);
	return Math.floor(Date.UTC(w.year, w.month - 1, w.day) / 86_400_000);
}

/** `YYYY-MM-DD` of an instant in the team timezone. */
export function isoDay(ms: number, tz: string = teamZone()): string {
	const w = wallClock(ms, tz);
	return `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;
}

/** The instant at which the wall clock of `tz` shows this date and time (DST gaps resolve forward). */
export function zonedEpoch(year: number, month: number, day: number, hour: number, minute: number, tz: string = teamZone()): number {
	const naive = Date.UTC(year, month - 1, day, hour, minute);
	let guess = naive;
	for (let i = 0; i < 3; i++) {
		const w = wallClock(guess, tz);
		const delta = naive - Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
		if (delta === 0) break;
		guess += delta;
	}
	return guess;
}

/** Compact relative time: "now", "5m", "3h", "2d", else a short date. */
export function timeAgo(ms: number | null | undefined, now: number = Date.now()): string {
	if (!ms) return '';
	const s = Math.max(0, Math.round((now - ms) / 1000));
	if (s < 45) return 'now';
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h}h`;
	const d = Math.round(h / 24);
	if (d < 7) return `${d}d`;
	return formatDate(ms);
}

/** USD with enough precision for small agent costs. */
export const formatUsd = (n: number): string => `$${n.toFixed(n < 1 ? 4 : 2)}`;
