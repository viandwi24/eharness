// Pure helpers of the Events page (the unified event stream): filters and their URL, the API query,
// the catalog grouped by source, and the words of a row. The rows come from `GET /events`.
import type { components } from '../api/schema';
import { formatDateTime, isoDay, zonedEpoch } from '../time';

export type StreamEvent = components['schemas']['StreamEvent'];
export type EventCatalog = components['schemas']['EventCatalog'];
export type EventTypeInfo = components['schemas']['EventTypeInfo'];
export type EventSource = StreamEvent['source'];

export const RANGES = [
	{ id: '1h', label: '1 hour' },
	{ id: 'today', label: 'Today' },
	{ id: '7d', label: '7 days' },
	{ id: 'all', label: 'All time' },
	{ id: 'custom', label: 'Custom' }
] as const;
export type RangeId = (typeof RANGES)[number]['id'];
export const DEFAULT_RANGE: RangeId = 'all';

export type EventFilters = {
	range: RangeId;
	/** `YYYY-MM-DD` in the team timezone (range `custom`). */
	from: string;
	to: string;
	source: '' | EventSource;
	types: string[];
	connectionId: string;
	chat: string;
	actor: string;
};

export const emptyFilters = (): EventFilters => ({ range: DEFAULT_RANGE, from: '', to: '', source: '', types: [], connectionId: '', chat: '', actor: '' });

const isDay = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v);
const TEXT_KEYS = ['connectionId', 'chat', 'actor'] as const;

/** Filters from a URL's search params (unknown values are ignored). */
export function filtersFromParams(p: Pick<URLSearchParams, 'get'>): EventFilters {
	const f = emptyFilters();
	const range = p.get('range');
	if (RANGES.some((r) => r.id === range)) f.range = range as RangeId;
	const from = p.get('from') ?? '';
	const to = p.get('to') ?? '';
	if (isDay(from)) f.from = from;
	if (isDay(to)) f.to = to;
	if ((f.from || f.to) && !RANGES.some((r) => r.id === range)) f.range = 'custom';
	const source = p.get('source');
	if (source === 'channel' || source === 'app') f.source = source;
	f.types = (p.get('type') ?? '')
		.split(',')
		.map((t) => t.trim())
		.filter(Boolean);
	for (const k of TEXT_KEYS) f[k] = p.get(k) ?? '';
	return f;
}

/** Search params of the non-default filters (the deep link); `e` is the open event. */
export function paramsFromFilters(f: EventFilters, openId?: string | null): URLSearchParams {
	const p = new URLSearchParams();
	if (f.range !== DEFAULT_RANGE) p.set('range', f.range);
	if (f.range === 'custom') {
		if (f.from) p.set('from', f.from);
		if (f.to) p.set('to', f.to);
	}
	if (f.source) p.set('source', f.source);
	if (f.types.length) p.set('type', f.types.join(','));
	for (const k of TEXT_KEYS) if (f[k]) p.set(k, f[k]);
	if (openId) p.set('e', openId);
	return p;
}

function dayStart(day: string, extraDays = 0): number {
	const [y, m, d] = day.split('-').map(Number) as [number, number, number];
	return zonedEpoch(y, m, d + extraDays, 0, 0);
}

/** The time window of a filter set, as epoch ms (`undefined` = open). `now` anchors the quick ranges. */
export function windowOf(f: EventFilters, now: number): { from?: number; to?: number } {
	if (f.range === '1h') return { from: now - 3_600_000 };
	if (f.range === 'today') return { from: dayStart(isoDay(now)) };
	if (f.range === '7d') return { from: now - 7 * 86_400_000 };
	if (f.range === 'custom') return { ...(f.from ? { from: dayStart(f.from) } : {}), ...(f.to ? { to: dayStart(f.to, 1) - 1 } : {}) };
	return {};
}

/** The API query of a filter set. */
export function queryOf(f: EventFilters, now: number): Record<string, string | number> {
	const q: Record<string, string | number> = { ...windowOf(f, now) };
	if (f.source) q.source = f.source;
	if (f.types.length) q.type = f.types.join(',');
	for (const k of TEXT_KEYS) if (f[k].trim()) q[k] = f[k].trim();
	return q;
}

/** How many filters besides the time range are on (the badge of the Filters button). */
export const activeFilterCount = (f: EventFilters): number => (f.source ? 1 : 0) + (f.types.length ? 1 : 0) + TEXT_KEYS.filter((k) => f[k]).length;

// ---- the catalog ----

export const SOURCE_LABEL: Record<EventSource, string> = { channel: 'Chat events', app: 'App events' };

/** The catalog's types grouped by source (chat first), each group in catalog order. */
export function groupCatalog(types: readonly EventTypeInfo[]): { source: EventSource; label: string; types: EventTypeInfo[] }[] {
	return (['channel', 'app'] as const)
		.map((source) => ({ source, label: SOURCE_LABEL[source], types: types.filter((t) => t.source === source) }))
		.filter((g) => g.types.length > 0);
}

/** The catalog label of a type, else the type itself. */
export const typeLabel = (types: readonly EventTypeInfo[], type: string): string => types.find((t) => t.type === type)?.label ?? type;

/** Add or remove one type from a selection (the order of the selection is kept). */
export const toggleType = (selected: readonly string[], type: string): string[] => (selected.includes(type) ? selected.filter((t) => t !== type) : [...selected, type]);

// ---- the words of a row ----

/** Full date and time in the team timezone ("Oct 24, 2026, 09:12:03"). */
export const eventTime = (ms: number): string => formatDateTime(ms, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Where an event came from: the connection label, or "app". */
export const sourceText = (e: Pick<StreamEvent, 'source' | 'sourceLabel'>): string => (e.source === 'app' ? 'app' : e.sourceLabel || 'chat');

/** The chat of an event on one line, or an empty string. */
export const chatText = (e: Pick<StreamEvent, 'chat'>): string => e.chat?.title ?? '';

/** The person behind an event: name, else @username, else id; the agent itself is "the agent". */
export function actorName(e: Pick<StreamEvent, 'actor'>): string {
	const a = e.actor;
	if (!a) return '';
	if (a.self) return 'the agent';
	return a.name || (a.username ? `@${a.username.replace(/^@/, '')}` : (a.id ?? ''));
}

/** `@username` when the name is shown and a username exists. */
export function actorHandle(e: Pick<StreamEvent, 'actor'>): string {
	const a = e.actor;
	if (!a || a.self || !a.name || !a.username) return '';
	return `@${a.username.replace(/^@/, '')}`;
}

/** The directory role of the actor, when known. */
export const actorRole = (e: Pick<StreamEvent, 'actor'>): string => e.actor?.role ?? '';

/** Facts of an event as sorted rows. */
export const factRows = (e: Pick<StreamEvent, 'fields'>): { key: string; value: string }[] =>
	Object.entries(e.fields)
		.map(([key, value]) => ({ key, value }))
		.sort((a, b) => a.key.localeCompare(b.key));

/** Merge a fresh first page into the loaded rows: the fresh ones on top, older loaded pages kept below. */
export function mergeFresh<T extends { id: string; at: number }>(fresh: readonly T[], loaded: readonly T[]): T[] {
	const seen = new Set(fresh.map((r) => r.id));
	const floor = fresh.at(-1)?.at ?? 0;
	return [...fresh, ...loaded.filter((r) => !seen.has(r.id) && r.at < floor)];
}

/**
 * The page that shows one event: a chat event opens on the Events page of its channel, an app event
 * goes to its own page. Mirrors `eventHref` of the server (`domain/event-stream.ts`).
 */
export function eventHref(e: Pick<StreamEvent, 'id' | 'source' | 'connectionId' | 'link'>): string {
	if (e.source === 'channel' && e.connectionId) return `/channels/${encodeURIComponent(e.connectionId)}/events?e=${encodeURIComponent(e.id)}`;
	return e.link ?? '/channels';
}
