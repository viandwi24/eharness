// Pure helpers of the Audit page (what the agents did on chat platforms): filters and their URL,
// the API query, and the words of a row. The rows come from `GET /audit/actions`.
import type { components } from '../api/schema';
import { actionLabel } from '../channels/model';
import { formatDateTime, isoDay, zonedEpoch } from '../time';

export type AuditRow = components['schemas']['AuditRow'];
export type AuditResult = AuditRow['result'];

export const RANGES = [
	{ id: 'today', label: 'Today' },
	{ id: '7d', label: '7 days' },
	{ id: '30d', label: '30 days' },
	{ id: 'all', label: 'All time' },
	{ id: 'custom', label: 'Custom' }
] as const;
export type RangeId = (typeof RANGES)[number]['id'];
export const DEFAULT_RANGE: RangeId = '7d';

export const KINDS = [
	{ id: 'action', label: 'Actions that change something' },
	{ id: 'read', label: 'Lookups only' },
	{ id: 'all', label: 'Actions and lookups' }
] as const;
export type KindId = (typeof KINDS)[number]['id'];

export const RESULTS: { id: AuditResult; label: string }[] = [
	{ id: 'ok', label: 'Done' },
	{ id: 'error', label: 'Failed' },
	{ id: 'refused', label: 'Refused' },
	{ id: 'rate_limited', label: 'Rate limited' }
];
export const resultLabel = (r: AuditResult): string => RESULTS.find((x) => x.id === r)?.label ?? r;
export const resultVariant = (r: AuditResult): 'success' | 'destructive' | 'warning' | 'secondary' => (r === 'ok' ? 'success' : r === 'error' ? 'destructive' : r === 'rate_limited' ? 'warning' : 'secondary');

export type AuditFilters = {
	range: RangeId;
	/** `YYYY-MM-DD` in the team timezone (range `custom`). */
	from: string;
	to: string;
	connectionId: string;
	/** `bot` or `user` (the kind of connector), '' = both. */
	transport: '' | 'bot' | 'user';
	kind: KindId;
	action: string;
	chat: string;
	requester: string;
	agentId: string;
	result: '' | AuditResult;
};

export const emptyFilters = (): AuditFilters => ({
	range: DEFAULT_RANGE,
	from: '',
	to: '',
	connectionId: '',
	transport: '',
	kind: 'action',
	action: '',
	chat: '',
	requester: '',
	agentId: '',
	result: ''
});

const isDay = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v);
const TEXT_KEYS = ['connectionId', 'action', 'chat', 'requester', 'agentId'] as const;

/** Filters from a URL's search params (unknown values are ignored). */
export function filtersFromParams(p: Pick<URLSearchParams, 'get'>): AuditFilters {
	const f = emptyFilters();
	const range = p.get('range');
	if (RANGES.some((r) => r.id === range)) f.range = range as RangeId;
	const from = p.get('from') ?? '';
	const to = p.get('to') ?? '';
	if (isDay(from)) f.from = from;
	if (isDay(to)) f.to = to;
	if ((f.from || f.to) && !RANGES.some((r) => r.id === range)) f.range = 'custom';
	const transport = p.get('transport');
	if (transport === 'bot' || transport === 'user') f.transport = transport;
	const kind = p.get('kind');
	if (KINDS.some((k) => k.id === kind)) f.kind = kind as KindId;
	const result = p.get('result');
	if (RESULTS.some((r) => r.id === result)) f.result = result as AuditResult;
	for (const k of TEXT_KEYS) f[k] = p.get(k) ?? '';
	return f;
}

/** Search params of the non-default filters (the deep link); `id` is the open row. */
export function paramsFromFilters(f: AuditFilters, id?: string | null): URLSearchParams {
	const p = new URLSearchParams();
	if (f.range !== DEFAULT_RANGE) p.set('range', f.range);
	if (f.range === 'custom') {
		if (f.from) p.set('from', f.from);
		if (f.to) p.set('to', f.to);
	}
	if (f.transport) p.set('transport', f.transport);
	if (f.kind !== 'action') p.set('kind', f.kind);
	if (f.result) p.set('result', f.result);
	for (const k of TEXT_KEYS) if (f[k]) p.set(k, f[k]);
	if (id) p.set('id', id);
	return p;
}

/** Start of the day `YYYY-MM-DD` in the team timezone. */
function dayStart(day: string, extraDays = 0): number {
	const [y, m, d] = day.split('-').map(Number) as [number, number, number];
	return zonedEpoch(y, m, d + extraDays, 0, 0);
}

/** The time window of a filter set, as epoch ms (`undefined` = open). `now` anchors the quick ranges. */
export function windowOf(f: AuditFilters, now: number): { from?: number; to?: number } {
	if (f.range === 'today') return { from: dayStart(isoDay(now)) };
	if (f.range === '7d') return { from: now - 7 * 86_400_000 };
	if (f.range === '30d') return { from: now - 30 * 86_400_000 };
	if (f.range === 'custom') return { ...(f.from ? { from: dayStart(f.from) } : {}), ...(f.to ? { to: dayStart(f.to, 1) - 1 } : {}) };
	return {};
}

/** The API query of a filter set (the list and the CSV take the same filters). */
export function queryOf(f: AuditFilters, now: number): Record<string, string | number> {
	const q: Record<string, string | number> = { ...windowOf(f, now) };
	if (f.kind !== 'all') q.kind = f.kind;
	if (f.transport) {
		q.transport = f.transport;
		q.platform = 'telegram';
	}
	if (f.result) q.result = f.result;
	for (const k of TEXT_KEYS) if (f[k].trim()) q[k] = f[k].trim();
	return q;
}

/** How many filters besides the time range are on (the badge of the Filters button). */
export const activeFilterCount = (f: AuditFilters): number => (['connectionId', 'transport', 'action', 'chat', 'requester', 'agentId', 'result'] as const).filter((k) => f[k]).length + (f.kind === 'action' ? 0 : 1);

// ---- the words of a row ----

/** Full date and time in the team timezone ("Oct 24, 2026, 09:12:03"). */
export const auditTime = (ms: number): string => formatDateTime(ms, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** "Telegram account" / "Telegram bot" (the kind of the connector). */
export function connectorText(r: Pick<AuditRow, 'platform' | 'transport'>): string {
	const platform = r.platform === 'unknown' ? 'Platform' : r.platform.charAt(0).toUpperCase() + r.platform.slice(1);
	return r.transport === 'user' ? `${platform} account` : r.transport === 'bot' ? `${platform} bot` : platform;
}

export const rowAction = (r: Pick<AuditRow, 'action' | 'summary'>): string => actionLabel(r.action, r.summary);

/** The target of a row on one line: chat, person and link, whichever the call named. */
export function targetText(r: Pick<AuditRow, 'target'>): string {
	const t = r.target;
	return [t.chat, t.user ? `user ${t.user}` : undefined, t.link].filter((x): x is string => !!x).join(' · ');
}

/** Who asked: a person, the app owner, or the agent on its own (a routine, a program). */
export function requesterText(r: Pick<AuditRow, 'requester' | 'origin'>): string {
	if (r.requester) return r.requester;
	return r.origin && r.origin !== 'chat' && r.origin !== 'dm' ? `autonomous ${r.origin}` : 'the agent';
}

/** The role of whoever asked, when the app knows it. */
export const roleText = (r: Pick<AuditRow, 'role' | 'requester'>): string | undefined => (r.role && !(r.requester === 'web owner' && r.role === 'owner') ? r.role : undefined);

/** `key=value` pairs of a summary as rows (`text=<13 chars>` stays as written: the text itself is never stored). */
export function summaryPairs(summary: string | undefined): { key: string; value: string }[] {
	if (!summary) return [];
	const out: { key: string; value: string }[] = [];
	for (const m of summary.matchAll(/([A-Za-z_][\w]*)=(.*?)(?=\s[A-Za-z_]\w*=|$)/g)) out.push({ key: m[1] as string, value: (m[2] as string).trim() });
	return out;
}

/** The pretty-printed raw row (the detail sheet's JSON). */
export const rawJson = (r: AuditRow): string => JSON.stringify(r, null, 2);
