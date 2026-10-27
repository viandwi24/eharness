// Pure helpers of the Logs charts: bucket widths, deltas, colors, stacking and axis scales.
import type { ModelCallStats } from '../api/client';
import { formatClock, formatDate } from '../time';
import type { RangeId } from './logs';

type Bucket = ModelCallStats['buckets'][number];
type Totals = ModelCallStats['totals'];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Bucket width of a range: minutes for the last hour, hours for a day, 6 hours for a week, days for a month. */
export const bucketMsFor = (range: RangeId): number => (range === '1h' ? 60_000 : range === '24h' ? HOUR : range === '7d' ? 6 * HOUR : DAY);

/** Start of the first bucket: day buckets begin at local midnight, shorter ones at a multiple of their width. */
export function alignStart(ms: number, bucketMs: number): number {
	if (bucketMs >= DAY) return new Date(ms).setHours(0, 0, 0, 0);
	return Math.floor(ms / bucketMs) * bucketMs;
}

// ---- colors --------------------------------------------------------------------------------------
// Slots are CSS variables (`--viz-1`..`--viz-7`, `--viz-other`, `--viz-ok` ...) defined by the chart
// root in light and dark; the entity keeps its slot whatever else is filtered.

export type SourceGroup = { id: string; label: string; slot: string; members: readonly string[] };

/** Cost sources as the chart shows them. Compaction, memory flush, the Auto classifier, web search, background jobs and "other" share one neutral group. */
export const SOURCE_GROUPS: readonly SourceGroup[] = [
	{ id: 'chat', label: 'Chat', slot: 'var(--viz-1)', members: ['chat'] },
	{ id: 'program', label: 'Programs', slot: 'var(--viz-2)', members: ['program'] },
	{ id: 'delegated', label: 'Delegated work', slot: 'var(--viz-3)', members: ['delegated'] },
	{ id: 'heartbeat', label: 'Heartbeat', slot: 'var(--viz-4)', members: ['heartbeat'] },
	{ id: 'routine', label: 'Routines', slot: 'var(--viz-5)', members: ['routine'] },
	{ id: 'api', label: 'Developer API', slot: 'var(--viz-6)', members: ['api'] },
	{ id: 'task', label: 'Tasks', slot: 'var(--viz-7)', members: ['task'] },
	{ id: 'system', label: 'System (compaction, flush, classifier, search, jobs)', slot: 'var(--viz-other)', members: ['compaction', 'flush', 'classifier', 'search', 'job', 'other'] }
];

export const SOURCES = [
	{ id: 'chat', label: 'Chat' },
	{ id: 'task', label: 'Tasks' },
	{ id: 'delegated', label: 'Delegated work' },
	{ id: 'program', label: 'Programs' },
	{ id: 'routine', label: 'Routines' },
	{ id: 'heartbeat', label: 'Heartbeat' },
	{ id: 'api', label: 'Developer API' },
	{ id: 'search', label: 'Web search' },
	{ id: 'job', label: 'Background jobs' },
	{ id: 'compaction', label: 'Compaction' },
	{ id: 'flush', label: 'Memory flush' },
	{ id: 'classifier', label: 'Classifier' },
	{ id: 'other', label: 'Other' }
] as const;

export const sourceLabel = (id: string): string => SOURCES.find((s) => s.id === id)?.label ?? id;

export const sourceGroupOf = (source: string): SourceGroup => SOURCE_GROUPS.find((g) => g.members.includes(source)) ?? SOURCE_GROUPS[SOURCE_GROUPS.length - 1]!;

export const AGENT_SLOTS = 7;
export const OTHER_AGENTS = { id: '__other', label: 'Other agents', slot: 'var(--viz-other)' };

/** Fixed color slot of an agent: its place in the (stable) agent list; later agents fold into "Other agents". */
export function agentSlot(agentIds: readonly string[], id: string | null): string {
	const i = id === null ? -1 : agentIds.indexOf(id);
	return i >= 0 && i < AGENT_SLOTS ? `var(--viz-${i + 1})` : OTHER_AGENTS.slot;
}

export const TOKEN_SERIES = [
	{ key: 'input', label: 'Input (not cached)', color: 'var(--viz-1)' },
	{ key: 'output', label: 'Output', color: 'var(--viz-2)' },
	{ key: 'cached', label: 'Input (cached)', color: 'var(--viz-3)' }
] as const;

/** Status colors are the reserved status palette: errors are always red. */
export const STATUS_SERIES = [
	{ key: 'ok', label: 'OK', color: 'var(--viz-ok)' },
	{ key: 'aborted', label: 'Aborted', color: 'var(--viz-aborted)' },
	{ key: 'error', label: 'Error', color: 'var(--viz-error)' }
] as const;

// ---- series --------------------------------------------------------------------------------------

export type Series = { key: string; label: string; color: string; values: number[] };

/** Cost per bucket stacked by source group (groups without any cost are left out). */
export function costBySourceSeries(buckets: readonly Bucket[]): Series[] {
	return SOURCE_GROUPS.map((g) => ({
		key: g.id,
		label: g.label,
		color: g.slot,
		values: buckets.map((b) => g.members.reduce((sum, m) => sum + (b.costBySource[m] ?? 0), 0))
	})).filter((s) => s.values.some((v) => v > 0));
}

/** Cost per bucket stacked by agent: up to 7 agents by their fixed slot, the rest (and calls without an agent) as "Other agents". */
export function costByAgentSeries(buckets: readonly Bucket[], agentIds: readonly string[], nameOf: (id: string) => string): Series[] {
	const known = agentIds.slice(0, AGENT_SLOTS);
	const series: Series[] = known.map((id, i) => ({
		key: id,
		label: nameOf(id),
		color: `var(--viz-${i + 1})`,
		values: buckets.map((b) => b.costByAgent[id] ?? 0)
	}));
	series.push({
		key: OTHER_AGENTS.id,
		label: OTHER_AGENTS.label,
		color: OTHER_AGENTS.slot,
		values: buckets.map((b) => Object.entries(b.costByAgent).reduce((sum, [id, v]) => sum + (known.includes(id) ? 0 : v), 0))
	});
	return series.filter((s) => s.values.some((v) => v > 0));
}

export function tokenSeries(buckets: readonly Bucket[]): Series[] {
	const values = {
		input: buckets.map((b) => Math.max(0, b.inputTokens - b.cachedTokens)),
		output: buckets.map((b) => b.outputTokens),
		cached: buckets.map((b) => Math.min(b.cachedTokens, b.inputTokens))
	};
	return TOKEN_SERIES.map((s) => ({ ...s, values: values[s.key] }));
}

export function statusSeries(buckets: readonly Bucket[]): Series[] {
	const values = {
		ok: buckets.map((b) => Math.max(0, b.count - b.errors - b.aborted)),
		aborted: buckets.map((b) => b.aborted),
		error: buckets.map((b) => b.errors)
	};
	return STATUS_SERIES.map((s) => ({ ...s, values: values[s.key] }));
}

// ---- numbers -------------------------------------------------------------------------------------

export type Delta = { text: string; dir: 'up' | 'down' | 'flat' | 'new' };

/** Change of `current` against `previous` as a percent label; `new` when there was nothing before. */
export function deltaOf(current: number, previous: number | null | undefined): Delta | null {
	if (previous === null || previous === undefined) return null;
	if (previous === 0) return current === 0 ? { text: 'no change', dir: 'flat' } : { text: 'new', dir: 'new' };
	const pct = ((current - previous) / previous) * 100;
	if (Math.abs(pct) < 0.5) return { text: 'no change', dir: 'flat' };
	const mag = Math.abs(pct) >= 1000 ? `${Math.round(Math.abs(pct) / 100) * 100}` : Math.abs(pct) >= 100 ? `${Math.round(Math.abs(pct))}` : Math.abs(pct).toFixed(Math.abs(pct) < 10 ? 1 : 0);
	return pct > 0 ? { text: `+${mag}%`, dir: 'up' } : { text: `−${mag}%`, dir: 'down' };
}

/** Share of input tokens that came from the prompt cache (0..1); null with no input. */
export const cacheHitRate = (t: Pick<Totals, 'cachedTokens' | 'inputTokens'>): number | null => (t.inputTokens > 0 ? Math.min(1, t.cachedTokens / t.inputTokens) : null);

/** Share of calls that failed (0..1); null with no calls. */
export const errorRate = (t: Pick<Totals, 'errors' | 'count'>): number | null => (t.count > 0 ? t.errors / t.count : null);

export const formatPercent = (r: number | null): string => (r === null ? '—' : r === 0 ? '0%' : r < 0.001 ? '<0.1%' : r < 0.1 ? `${(r * 100).toFixed(1)}%` : `${Math.round(r * 100)}%`);

/** Sum of every series at bucket `i`. */
export const stackTotal = (series: readonly Series[], i: number): number => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0);

/** A round axis maximum and its gridline values (about `ticks` steps) covering `max`. */
export function niceScale(max: number, ticks = 4): { max: number; lines: number[] } {
	if (!(max > 0)) return { max: 1, lines: [0, 0.5, 1] };
	const raw = max / ticks;
	const mag = 10 ** Math.floor(Math.log10(raw));
	const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
	const top = Math.ceil(max / step - 1e-9) * step;
	const n = Math.round(top / step);
	return { max: top, lines: Array.from({ length: n + 1 }, (_, i) => +(i * step).toPrecision(12)) };
}

// ---- labels --------------------------------------------------------------------------------------

/** Axis label of a bucket: a time inside a day, a date for day buckets. */
export function axisLabel(ms: number, bucketMs: number): string {
	return bucketMs >= DAY ? formatDate(ms) : bucketMs >= 6 * HOUR ? `${formatDate(ms)} ${formatClock(ms)}` : formatClock(ms);
}

/** Tooltip title of a bucket: its date and the span it covers. */
export function bucketTitle(ms: number, bucketMs: number): string {
	if (bucketMs >= DAY) return formatDate(ms);
	return `${formatDate(ms)} ${formatClock(ms)}–${formatClock(ms + bucketMs)}`;
}

/** Indices of the buckets that get an x-axis label: evenly spread, at most `max`. */
export function labelIndices(count: number, max: number): number[] {
	if (count <= 0) return [];
	if (count <= max) return Array.from({ length: count }, (_, i) => i).filter((i) => count <= 6 || i % Math.ceil(count / max) === 0);
	const step = Math.ceil(count / max);
	return Array.from({ length: Math.ceil(count / step) }, (_, i) => i * step);
}

/** A dollar tick of the cost axis: $0, two decimals from one cent, two significant digits below. */
export function axisUsd(v: number): string {
	if (v === 0) return '$0';
	return v >= 0.01 ? `$${v.toFixed(2)}` : `$${Number(v.toPrecision(2))}`;
}
