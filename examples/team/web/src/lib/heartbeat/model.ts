// The heartbeat panel's view model. Pure.
import type { components } from '../api/schema';

export type Heartbeat = components['schemas']['Heartbeat'];
export type HeartbeatConfig = components['schemas']['HeartbeatConfig'];
export type BeatRecord = components['schemas']['BeatRecord'];
export type DigestView = components['schemas']['DigestView'];
export type BeatStatus = BeatRecord['status'];

export const MIN_EVERY_MINUTES = 5;
export const MAX_EVERY_MINUTES = 1440;
export const MAX_POSTS_PER_DAY = 50;

/** The form as typed: strings and a number, exactly what the inputs hold. */
export interface HeartbeatForm {
	enabled: boolean;
	everyMinutes: number;
	activeFrom: string;
	activeTo: string;
	timezone: string;
	mode: HeartbeatConfig['mode'];
	/** The node id of the chat to report to; '' = never post. */
	reportTo: string;
	maxPostsPerDay: number;
	wakeOnActivity: boolean;
	minGapMinutes: number;
}

export type Destination = Heartbeat['destinations'][number];

export const formOf = (c: HeartbeatConfig): HeartbeatForm => ({
	enabled: c.enabled,
	everyMinutes: c.everyMinutes,
	activeFrom: c.activeFrom,
	activeTo: c.activeTo,
	// empty = follow the team timezone (Settings)
	timezone: c.timezone ?? '',
	mode: c.mode,
	reportTo: c.reportTo?.nodeId ?? '',
	maxPostsPerDay: c.maxPostsPerDay,
	wakeOnActivity: c.wakeOnActivity,
	minGapMinutes: c.minGapMinutes
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
	if (!Number.isInteger(f.maxPostsPerDay) || f.maxPostsPerDay < 0 || f.maxPostsPerDay > MAX_POSTS_PER_DAY) {
		out.maxPostsPerDay = `Whole number, 0 to ${MAX_POSTS_PER_DAY}`;
	}
	if (!Number.isInteger(f.minGapMinutes) || f.minGapMinutes < 1 || f.minGapMinutes > MAX_EVERY_MINUTES) {
		out.minGapMinutes = `Whole minutes, 1 to ${MAX_EVERY_MINUTES}`;
	}
	return out;
}

/** The fields that changed, as the PATCH body (`destinations` turns the chosen chat into its connection and node). */
export function patchOf(saved: HeartbeatConfig, f: HeartbeatForm, destinations: readonly Destination[] = []): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const k of ['enabled', 'everyMinutes', 'activeFrom', 'activeTo', 'maxPostsPerDay', 'wakeOnActivity', 'minGapMinutes', 'mode'] as const) {
		if (f[k] !== saved[k]) out[k] = f[k];
	}
	// an empty timezone goes back to following the team timezone
	if (f.timezone.trim() !== (saved.timezone ?? '')) out.timezone = f.timezone.trim() === '' ? null : f.timezone.trim();
	if (f.reportTo !== (saved.reportTo?.nodeId ?? '')) {
		const chosen = destinations.find((d) => d.nodeId === f.reportTo);
		out.reportTo = f.reportTo === '' || chosen === undefined ? null : { connectionId: chosen.connectionId, nodeId: chosen.nodeId };
	}
	return out;
}

export const MODES: Array<{ value: HeartbeatConfig['mode']; label: string; hint: string }> = [
	{ value: 'off', label: 'Off: findings only', hint: 'It reports what the server finds (digest, bell) and reads no chats on its own.' },
	{ value: 'notes', label: 'Notes: observe and keep notes', hint: 'It reads the chats it can see and keeps daily notes. It never posts; it tells you through the digest or the bell.' },
	{ value: 'speak', label: 'Speak: may post to the report chat', hint: 'Like Notes, and it may post one short message to the report chat when its rules say it helps. Most beats still only take notes.' }
];

/** `/files` link of a library path. */
export const filesLink = (path: string): string => `/files?path=${encodeURIComponent(path)}`;

/** The audit line of an item: what the beat did and why. */
export function decisionLine(item: { decision?: string | undefined; reason?: string | undefined }): string {
	const what = item.decision === 'say' ? 'Said it' : item.decision === 'escalate' ? 'Told you' : item.decision === 'note' ? 'Noted' : '';
	return [what, item.reason].filter((x) => x !== undefined && x !== '').join(': ');
}

/** What the checklist state means for the owner, in one sentence (the heartbeat does nothing when it is empty). */
export function checklistNotice(c: { exists: boolean; empty: boolean }, enabled: boolean): { tone: 'warning' | 'muted'; text: string } | null {
	if (!c.empty) return null;
	const why = c.exists ? 'The checklist has only headings or comments' : 'There is no checklist yet';
	return enabled
		? { tone: 'warning', text: `${why}, so every beat is skipped: the heartbeat does nothing. Write what it should watch below.` }
		: { tone: 'muted', text: `${why}. Write what it should watch before turning it on.` };
}

/** A line under a destination: why posts there would be refused. */
export const destinationWarning = (d: Destination | undefined): string | null =>
	d !== undefined && !d.proactive ? 'This chat does not allow unasked posts: allow "proactive" in its settings or every post is refused.' : null;

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
	const early = b.trigger === 'activity' ? ' (started by chat activity)' : '';
	if (b.status === 'skipped') return `${b.reason ?? 'skipped'}${b.count > 1 ? ` (${b.count} times)` : ''}`;
	if (b.status === 'failed') return b.reason ?? 'failed';
	if (b.status === 'attention') {
		const n = b.items.length;
		return `${n} new item${n === 1 ? '' : 's'}${b.duplicates > 0 ? `, ${b.duplicates} already reported` : ''}${early}`;
	}
	if (b.status === 'ok') return `${b.duplicates > 0 ? `${b.duplicates} finding${b.duplicates === 1 ? '' : 's'} already reported` : 'Nothing needed attention'}${early}`;
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
