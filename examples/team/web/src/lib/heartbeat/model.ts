// The heartbeat panel's view model. Pure.
import type { components } from '../api/schema';

export type Heartbeat = components['schemas']['Heartbeat'];
export type HeartbeatConfig = components['schemas']['HeartbeatConfig'];
export type BeatRecord = components['schemas']['BeatRecord'];
export type DigestView = components['schemas']['DigestView'];
export type BeatStatus = BeatRecord['status'];

export const MIN_EVERY_MINUTES = 5;
export const MAX_EVERY_MINUTES = 1440;

/** The form as typed: strings and a number, exactly what the inputs hold. */
export interface HeartbeatForm {
	enabled: boolean;
	everyMinutes: number;
	activeFrom: string;
	activeTo: string;
	timezone: string;
}

export const formOf = (c: HeartbeatConfig): HeartbeatForm => ({
	enabled: c.enabled,
	everyMinutes: c.everyMinutes,
	activeFrom: c.activeFrom,
	activeTo: c.activeTo,
	// empty = follow the team timezone (Settings)
	timezone: c.timezone ?? ''
});

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isTimezone(tz: string): boolean {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

/** Field errors of the form, empty when it is valid. */
export function formErrors(f: HeartbeatForm): Record<string, string> {
	const out: Record<string, string> = {};
	if (!Number.isInteger(f.everyMinutes) || f.everyMinutes < MIN_EVERY_MINUTES || f.everyMinutes > MAX_EVERY_MINUTES) {
		out.everyMinutes = `Whole minutes, ${MIN_EVERY_MINUTES} to ${MAX_EVERY_MINUTES}`;
	}
	if (!CLOCK.test(f.activeFrom)) out.activeFrom = 'Use HH:MM (24 hours)';
	if (!CLOCK.test(f.activeTo)) out.activeTo = 'Use HH:MM (24 hours)';
	if (f.timezone.trim() !== '' && !isTimezone(f.timezone.trim())) out.timezone = 'Not a timezone (try Europe/Berlin or UTC)';
	return out;
}

/** The fields that changed, as the PATCH body. */
export function patchOf(saved: HeartbeatConfig, f: HeartbeatForm): Partial<Omit<HeartbeatForm, 'timezone'>> & { timezone?: string | null } {
	const out: Record<string, unknown> = {};
	for (const k of ['enabled', 'everyMinutes', 'activeFrom', 'activeTo'] as const) {
		if (f[k] !== saved[k]) out[k] = f[k];
	}
	// an empty timezone goes back to following the team timezone
	if (f.timezone.trim() !== (saved.timezone ?? '')) out.timezone = f.timezone.trim() === '' ? null : f.timezone.trim();
	return out;
}

export const BEAT_LABEL: Record<BeatStatus, string> = {
	running: 'Running',
	ok: 'All quiet',
	attention: 'Attention',
	skipped: 'Skipped',
	failed: 'Failed'
};

/** The badge variant a status gets. */
export const beatTone = (s: BeatStatus): 'success' | 'warning' | 'destructive' | 'info' | 'outline' =>
	s === 'attention' ? 'warning' : s === 'failed' ? 'destructive' : s === 'ok' ? 'success' : s === 'running' ? 'info' : 'outline';

/** One line under a beat: what it found, or why nothing ran. */
export function beatDetail(b: BeatRecord): string {
	if (b.status === 'skipped') return `${b.reason ?? 'skipped'}${b.count > 1 ? ` (${b.count} times)` : ''}`;
	if (b.status === 'failed') return b.reason ?? 'failed';
	if (b.status === 'attention') {
		const n = b.items.length;
		return `${n} new item${n === 1 ? '' : 's'}${b.duplicates > 0 ? `, ${b.duplicates} already reported` : ''}`;
	}
	if (b.status === 'ok') return b.duplicates > 0 ? `${b.duplicates} finding${b.duplicates === 1 ? '' : 's'} already reported` : 'Nothing needed attention';
	return 'In progress';
}

/** `every 30 min, 08:00-20:00 Europe/Berlin` (`effectiveTimezone`: the agent's own, else the team's) */
export function scheduleSummary(c: HeartbeatConfig, effectiveTimezone: string = c.timezone ?? 'UTC'): string {
	const every = c.everyMinutes % 60 === 0 ? `${c.everyMinutes / 60} h` : `${c.everyMinutes} min`;
	const hours = c.activeFrom === c.activeTo ? 'around the clock' : `${c.activeFrom}-${c.activeTo} ${effectiveTimezone}`;
	return `every ${every}, ${hours}`;
}

/** IANA timezones for the input's suggestions (the runtime's list; a short fallback). */
export function timezoneOptions(): string[] {
	const fn = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
	try {
		return ['UTC', ...(fn ? fn('timeZone') : ['Europe/Berlin', 'America/New_York', 'Asia/Jakarta'])];
	} catch {
		return ['UTC'];
	}
}
