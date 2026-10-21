// The heartbeat panel's view model. Pure.
import type { components } from '../api/schema';

export type Heartbeat = components['schemas']['Heartbeat'];
export type HeartbeatConfig = components['schemas']['HeartbeatConfig'];
export type BeatRecord = components['schemas']['BeatRecord'];
export type DigestView = components['schemas']['DigestView'];
export type BeatStatus = BeatRecord['status'];

export const MIN_EVERY_MINUTES = 5;
export const MAX_EVERY_MINUTES = 1440;

export type StandingOrder = Heartbeat['orders'][number];

/** The advanced form as typed: strings and a number, exactly what the inputs hold. */
export interface HeartbeatForm {
	everyMinutes: number;
	activeFrom: string;
	activeTo: string;
	timezone: string;
	afterActivity: boolean;
}

export const formOf = (c: HeartbeatConfig): HeartbeatForm => ({
	everyMinutes: c.everyMinutes,
	activeFrom: c.activeFrom,
	activeTo: c.activeTo,
	// empty = follow the team timezone (Settings)
	timezone: c.timezone ?? '',
	afterActivity: c.afterActivity
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
export function patchOf(saved: HeartbeatConfig, f: HeartbeatForm): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const k of ['everyMinutes', 'activeFrom', 'activeTo'] as const) {
		if (f[k] !== saved[k]) out[k] = f[k];
	}
	// an empty timezone goes back to following the team timezone
	if (f.afterActivity !== saved.afterActivity) out.afterActivity = f.afterActivity;
	if (f.timezone.trim() !== (saved.timezone ?? '')) out.timezone = f.timezone.trim() === '' ? null : f.timezone.trim();
	return out;
}

/** The cost note under the "after chat activity" switch. */
export const ACTIVITY_COST_NOTE =
	'Every early beat is a model call, and the scheduled beat already reads the new messages of the chats it watches. Leave this off unless a standing order must react within minutes.';

/** The week line of the tab: `12 beats, 31 skipped (nothing new), 3 items, $0.42`. */
export function weekSummary(w: Heartbeat['week']): string {
	const beats = `${w.beats} beat${w.beats === 1 ? '' : 's'} this week`;
	const skipped = w.unchanged > 0 ? `, ${w.unchanged} skipped (nothing new)` : '';
	const items = `${w.items} useful item${w.items === 1 ? '' : 's'}`;
	return `${beats}${skipped} · ${items} · ${w.costUsd < 0.01 && w.costUsd > 0 ? '<$0.01' : `$${w.costUsd.toFixed(2)}`} this week`;
}

/** `/files` link of a library path. */
export const filesLink = (path: string): string => `/files?path=${encodeURIComponent(path)}`;

/** The audit line of an item: what the beat did and why (`say` is the old word for a report). */
export function decisionLine(item: { decision?: string | undefined; reason?: string | undefined }): string {
	const what = item.decision === 'report' || item.decision === 'say' ? 'Reported' : item.decision === 'escalate' ? 'Told you' : item.decision === 'note' ? 'Noted' : item.decision === 'retry' ? 'Retried' : '';
	return [what, item.reason].filter((x) => x !== undefined && x !== '').join(': ');
}

/** Who gave an order, in a few words: `Ana (admin)`, `You (owner)` for the web app. */
export function orderWho(o: Pick<StandingOrder, 'by' | 'name' | 'role'>): string {
	const name = o.by === 'web:owner' ? 'You' : o.name.trim() === '' ? 'Someone' : o.name;
	return `${name} (${o.role})`;
}

/** Where an order reports, in a few words: the chat name, with a tag when it mentions the person. */
export function orderWhere(o: Pick<StandingOrder, 'reportLabel' | 'report' | 'mention'>): string {
	return o.report.kind === 'web' ? 'Reports in the web chat' : `Reports to ${o.reportLabel}${o.mention ? ', tagging them' : ''}`;
}

export type OrderKind = StandingOrder['kind'];

export const KIND_ORDER: readonly OrderKind[] = ['deadline', 'rule', 'ledger', 'watch'];

export const KIND_LABEL: Record<OrderKind, string> = {
	deadline: 'Deadlines',
	rule: 'Rules',
	ledger: 'Ledgers',
	watch: 'Watching'
};

export const KIND_HINT: Record<OrderKind, string> = {
	deadline: 'One check at an exact time, then done with an outcome.',
	rule: 'React when something happens.',
	ledger: 'Keeps a tracker file and warns on its rule.',
	watch: 'Ongoing: keeps an eye on something.'
};

/** Orders still doing something, grouped by kind (empty groups left out), and the done or expired ones apart. */
export function groupOrders(orders: readonly StandingOrder[]): {
	groups: Array<{ kind: OrderKind; label: string; hint: string; orders: StandingOrder[] }>;
	closed: StandingOrder[];
} {
	const open = orders.filter((o) => o.state === 'active' || o.state === 'paused');
	const groups = KIND_ORDER.map((kind) => ({
		kind,
		label: KIND_LABEL[kind],
		hint: KIND_HINT[kind],
		orders: open.filter((o) => o.kind === kind).sort((a, b) => (a.due ?? a.at) - (b.due ?? b.at))
	})).filter((g) => g.orders.length > 0);
	return { groups, closed: orders.filter((o) => o.state === 'done' || o.state === 'expired') };
}

/** `Due 16 Oct, 12:00` / `Expires ...` / `Done ...: outcome`, as short phrases. */
export function orderTiming(o: StandingOrder, format: (ms: number) => string): string[] {
	const out: string[] = [];
	if (o.due !== undefined) out.push(`Due ${format(o.due)}`);
	if (o.expires !== undefined) out.push(o.state === 'expired' ? `Expired ${format(o.expires)}` : `Expires ${format(o.expires)}`);
	if (o.done) out.push(`Done ${format(o.done.at)}`);
	return out;
}

/** A reference of an order as text and, when it points somewhere the app can open, a link. */
export function refLink(ref: string): { text: string; href?: string } {
	if (/^https?:\/\//i.test(ref)) return { text: ref, href: ref };
	if (ref.startsWith('/library/')) return { text: ref, href: filesLink(ref) };
	return { text: ref };
}

/** The sentence under an empty list of orders. */
export const NO_ORDERS =
	'No standing orders yet. Tell the agent in chat what to keep an eye on, for example: "watch the community channel all the time and tell me anything strange".';

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
