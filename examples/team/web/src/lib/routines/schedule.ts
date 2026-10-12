import type { components } from '../api/schema';

export type RoutineSpec = components['schemas']['RoutineSpec'];

export type ScheduleKind = 'daily' | 'weekdays' | 'weekly' | 'every' | 'custom' | 'once';

/** The editor's schedule fields; `buildSpec` turns them into the API shape. */
export type ScheduleForm = {
	kind: ScheduleKind;
	/** `HH:MM` (daily / weekdays / weekly). */
	time: string;
	/** 0 (Sunday) to 6 (weekly). */
	weekday: number;
	/** Minutes between runs (every). */
	everyMinutes: number;
	/** Seconds between runs when the interval is not a whole number of minutes (every); null = use `everyMinutes`. */
	everySeconds: number | null;
	/** Raw cron (custom). */
	expr: string;
	/** Epoch ms (once). */
	at: number;
	tz: string;
};

/** The server refuses shorter intervals. */
export const MIN_EVERY_SECONDS = 10;

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const SCHEDULE_PRESETS: { id: ScheduleKind; label: string }[] = [
	{ id: 'daily', label: 'Every day at…' },
	{ id: 'weekdays', label: 'Weekdays at…' },
	{ id: 'weekly', label: 'Every week on…' },
	{ id: 'every', label: 'Every N minutes' },
	{ id: 'custom', label: 'Custom cron' },
	{ id: 'once', label: 'Once' }
];

export const browserTimezone = (): string => {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	} catch {
		return 'UTC';
	}
};

export const defaultScheduleForm = (tz: string = browserTimezone()): ScheduleForm => ({
	kind: 'daily',
	time: '09:00',
	weekday: 1,
	everyMinutes: 30,
	everySeconds: null,
	expr: '0 9 * * 1-5',
	at: Date.now() + 3_600_000,
	tz
});

const pad = (n: number): string => String(n).padStart(2, '0');

export function parseTime(time: string): { h: number; m: number } | null {
	const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
	if (!m) return null;
	const h = Number(m[1]);
	const min = Number(m[2]);
	return h < 24 && min < 60 ? { h, m: min } : null;
}

/** Basic shape check of a cron expression: 5 or 6 fields of cron characters. The server parses for real. */
export function validCronShape(expr: string): boolean {
	const f = expr.trim().split(/\s+/);
	return (f.length === 5 || f.length === 6) && f.every((x) => /^[\w*/,\-?#LW]+$/i.test(x));
}

/** Schedule fields -> API spec. Throws `Error` with a user-readable message when invalid. */
export function buildSpec(f: ScheduleForm): RoutineSpec {
	switch (f.kind) {
		case 'daily':
		case 'weekdays':
		case 'weekly': {
			const t = parseTime(f.time);
			if (!t) throw new Error('Enter a time like 09:00');
			const dow = f.kind === 'daily' ? '*' : f.kind === 'weekdays' ? '1-5' : String(f.weekday);
			return { kind: 'cron', expr: `${t.m} ${t.h} * * ${dow}`, tz: f.tz };
		}
		case 'every': {
			if (f.everySeconds !== null) {
				const sec = Math.floor(f.everySeconds);
				if (!Number.isFinite(sec) || sec < MIN_EVERY_SECONDS) throw new Error(`Interval must be at least ${MIN_EVERY_SECONDS} seconds`);
				return { kind: 'every', everyMs: sec * 1000 };
			}
			const n = Math.floor(f.everyMinutes);
			if (!Number.isFinite(n) || n < 1) throw new Error('Interval must be at least 1 minute');
			return { kind: 'every', everyMs: n * 60_000 };
		}
		case 'custom':
			if (!validCronShape(f.expr)) throw new Error('Cron needs 5 or 6 fields, e.g. 0 9 * * 1-5');
			return { kind: 'cron', expr: f.expr.trim().replace(/\s+/g, ' '), tz: f.tz };
		case 'once':
			if (!Number.isFinite(f.at)) throw new Error('Pick a date and time');
			return { kind: 'at', at: f.at };
	}
}

/** API spec -> editor fields (the inverse of `buildSpec`; unknown cron shapes become `custom`). */
export function parseSpec(spec: RoutineSpec, fallbackTz: string = browserTimezone()): ScheduleForm {
	const base = defaultScheduleForm(fallbackTz);
	if (spec.kind === 'at') return { ...base, kind: 'once', at: spec.at };
	if (spec.kind === 'every') {
		// not a whole number of minutes (10 s, 90 s): keep it in seconds, so editing never changes it
		const exact = spec.everyMs % 60_000 === 0;
		return { ...base, kind: 'every', everyMinutes: Math.max(1, Math.round(spec.everyMs / 60_000)), everySeconds: exact ? null : Math.round(spec.everyMs / 1000) };
	}
	const m = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-6])$/.exec(spec.expr.trim());
	if (m && Number(m[1]) < 60 && Number(m[2]) < 24) {
		const time = `${pad(Number(m[2]))}:${pad(Number(m[1]))}`;
		const dow = m[3]!;
		if (dow === '*') return { ...base, kind: 'daily', time, tz: spec.tz };
		if (dow === '1-5') return { ...base, kind: 'weekdays', time, tz: spec.tz };
		return { ...base, kind: 'weekly', time, weekday: Number(dow), tz: spec.tz };
	}
	return { ...base, kind: 'custom', expr: spec.expr, tz: spec.tz };
}

/** One-line human text for a spec. */
export function describeSpec(spec: RoutineSpec): string {
	const f = parseSpec(spec, spec.kind === 'cron' ? spec.tz : 'UTC');
	switch (f.kind) {
		case 'daily':
			return `Every day at ${f.time}`;
		case 'weekdays':
			return `Weekdays at ${f.time}`;
		case 'weekly':
			return `${WEEKDAYS[f.weekday]}s at ${f.time}`;
		case 'every':
			if (f.everySeconds !== null) return f.everySeconds === 1 ? 'Every second' : `Every ${f.everySeconds} seconds`;
			return f.everyMinutes % 60 === 0
				? f.everyMinutes === 60
					? 'Every hour'
					: `Every ${f.everyMinutes / 60} hours`
				: f.everyMinutes === 1
					? 'Every minute'
					: `Every ${f.everyMinutes} minutes`;
		case 'once':
			return `Once, ${new Date(f.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
		default:
			return `Cron ${f.expr}`;
	}
}

/** The zone as people write it ("WIB" for Asia/Jakarta), else the IANA id. */
export function zoneLabel(tz: string): string {
	try {
		const part = new Intl.DateTimeFormat('id-ID', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value;
		return part && !/^GMT[+-]/.test(part) ? part : tz;
	} catch {
		return tz;
	}
}

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** A cron day-of-week field in words, or null when it is too unusual to say. */
function dowWords(dow: string): string | null {
	if (dow === '*') return 'every day';
	if (dow === '1-5') return 'every weekday';
	if (dow === '0,6' || dow === '6,0') return 'every weekend day';
	if (/^[0-7]$/.test(dow)) return `every ${WEEKDAYS[Number(dow) % 7]}`;
	if (/^[0-7](,[0-7])+$/.test(dow)) return `every ${dow.split(',').map((d) => DAY_SHORT[Number(d) % 7]).join(', ')}`;
	if (/^[0-7]-[0-7]$/.test(dow)) {
		const [a, b] = dow.split('-').map(Number) as [number, number];
		return `${DAY_SHORT[a % 7]} to ${DAY_SHORT[b % 7]}`;
	}
	return null;
}

/**
 * A schedule as a sentence with the zone, never raw cron: "Every weekday at 09:00 WIB",
 * "Every 2 hours", "On day 1 of every month at 08:00 WIB". Unusual cron shapes say so plainly.
 */
export function describeScheduleWords(spec: RoutineSpec): string {
	if (spec.kind !== 'cron') return describeSpec(spec);
	const zone = zoneLabel(spec.tz);
	const parts = spec.expr.trim().split(/\s+/);
	if (parts.length === 5) {
		const [m, h, dom, mon, dow] = parts as [string, string, string, string, string];
		const clock = /^\d{1,2}$/.test(m) && /^\d{1,2}$/.test(h) ? `${pad(Number(h))}:${pad(Number(m))}` : null;
		if (clock && mon === '*' && dom === '*') {
			const words = dowWords(dow);
			if (words) return `${words[0]!.toUpperCase()}${words.slice(1)} at ${clock} ${zone}`;
		}
		if (clock && mon === '*' && dow === '*' && /^\d{1,2}$/.test(dom)) return `On day ${dom} of every month at ${clock} ${zone}`;
		const every = /^\*\/(\d{1,2})$/.exec(h);
		if (every && m === '0' && dom === '*' && mon === '*' && dow === '*') return `Every ${every[1]} hours`;
		const mins = /^\*\/(\d{1,2})$/.exec(m);
		if (mins && h === '*' && dom === '*' && mon === '*' && dow === '*') return `Every ${mins[1]} minutes`;
	}
	return `On a custom schedule (${spec.expr}, ${zone})`;
}

/** `datetime-local` input value (local time) <-> epoch ms. */
export const toLocalInput = (ms: number): string => {
	const d = new Date(ms);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const fromLocalInput = (v: string): number => new Date(v).getTime();

export const CATCH_UP_OPTIONS: { value: number | null; label: string }[] = [
	{ value: null, label: 'Skip missed runs' },
	{ value: 3_600_000, label: 'Run once if missed within 1 hour' },
	{ value: 86_400_000, label: 'Run once if missed within 1 day' },
	{ value: 7 * 86_400_000, label: 'Run once if missed within 7 days' }
];

export function timezones(current?: string): string[] {
	let list: string[] = [];
	try {
		list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
	} catch {
		list = [];
	}
	if (!list.length) list = ['UTC', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Asia/Jakarta', 'Asia/Tokyo', 'Australia/Sydney'];
	if (!list.includes('UTC')) list = ['UTC', ...list];
	return current && !list.includes(current) ? [current, ...list] : list;
}

export type RoutineBadge = { label: string; variant: 'success' | 'secondary' | 'warning' | 'destructive' };

const PAUSE_TEXT: Record<string, string> = {
	manual: 'paused',
	'max-failures': 'paused: too many failures',
	'max-fires': 'finished',
	ended: 'ended',
	completed: 'completed',
	'agent-archived': 'agent archived',
	unrunnable: 'paused: cannot run'
};

export function routineBadge(r: { status: 'active' | 'paused'; pausedReason: string | null; failures: number }): RoutineBadge {
	if (r.status === 'active') return { label: r.failures > 0 ? `active, ${r.failures} failed` : 'active', variant: r.failures > 0 ? 'warning' : 'success' };
	return { label: PAUSE_TEXT[r.pausedReason ?? 'manual'] ?? 'paused', variant: r.pausedReason === 'max-failures' ? 'destructive' : 'secondary' };
}

/** "in 5 min", "in 2 h", "tomorrow 09:00" style text for the next fire. */
export function relativeTime(ms: number | null | undefined, now: number = Date.now()): string {
	if (!ms) return '—';
	const d = ms - now;
	const abs = Math.abs(d);
	const text =
		abs < 60_000 ? 'under a minute' : abs < 3_600_000 ? `${Math.round(abs / 60_000)} min` : abs < 86_400_000 ? `${Math.round(abs / 3_600_000)} h` : `${Math.round(abs / 86_400_000)} d`;
	return d >= 0 ? `in ${text}` : `${text} ago`;
}
