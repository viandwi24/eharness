// Pure helpers of the Logs page: ranges, filters, speed, and the readable prompt.
import type { ModelCallDetail, ModelCallStatus, ModelCallSummary } from '../api/client';
import { formatClock, formatDate, formatDateTime as teamDateTime } from '../time';

export const RANGES = [
	{ id: '1h', label: 'Last hour', ms: 3_600_000 },
	{ id: '24h', label: 'Last 24 hours', ms: 86_400_000 },
	{ id: '7d', label: 'Last 7 days', ms: 7 * 86_400_000 },
	{ id: '30d', label: 'Last 30 days', ms: 30 * 86_400_000 }
] as const;
export type RangeId = (typeof RANGES)[number]['id'];
export const DEFAULT_RANGE: RangeId = '30d';

export const KINDS = [
	{ id: 'step', label: 'Step' },
	{ id: 'compaction', label: 'Compaction' },
	{ id: 'flush', label: 'Memory flush' },
	{ id: 'search', label: 'Web search' },
	{ id: 'job', label: 'Background job' },
	{ id: 'other', label: 'Other' }
] as const;
/** Values of the `source` filter (the server's `ModelCallSource`). */
const SOURCE_IDS: readonly string[] = ['chat', 'task', 'delegated', 'program', 'routine', 'heartbeat', 'api', 'search', 'job', 'compaction', 'flush', 'classifier', 'other'];
export const STATUSES = ['ok', 'error', 'aborted'] as const;

export const kindLabel = (kind: string): string => KINDS.find((k) => k.id === kind)?.label ?? kind;

export type LogFilters = {
	range: RangeId;
	agentId: string;
	sessionId: string;
	kind: string;
	status: string;
	source: string;
	model: string;
	q: string;
};

export const emptyFilters = (): LogFilters => ({ range: DEFAULT_RANGE, agentId: '', sessionId: '', kind: '', status: '', source: '', model: '', q: '' });

const isRange = (v: string | null): v is RangeId => RANGES.some((r) => r.id === v);

/** Filters from a URL's search params (unknown values are ignored). */
export function filtersFromParams(p: Pick<URLSearchParams, 'get'>): LogFilters {
	const range = p.get('range');
	const kind = p.get('kind') ?? '';
	const status = p.get('status') ?? '';
	return {
		range: isRange(range) ? range : DEFAULT_RANGE,
		agentId: p.get('agentId') ?? '',
		sessionId: p.get('sessionId') ?? '',
		kind: KINDS.some((k) => k.id === kind) ? kind : '',
		status: (STATUSES as readonly string[]).includes(status) ? status : '',
		source: SOURCE_IDS.includes(p.get('source') ?? '') ? (p.get('source') ?? '') : '',
		model: p.get('model') ?? '',
		q: p.get('q') ?? ''
	};
}

/** Search params of the non-default filters (the deep link); `id` is the open call. */
export function paramsFromFilters(f: LogFilters, id?: string | null): URLSearchParams {
	const p = new URLSearchParams();
	if (f.range !== DEFAULT_RANGE) p.set('range', f.range);
	for (const k of ['agentId', 'sessionId', 'kind', 'status', 'source', 'model', 'q'] as const) if (f[k]) p.set(k, f[k]);
	if (id) p.set('id', id);
	return p;
}

/** The API query of a filter set (`now` anchors the range). */
export function queryOf(f: LogFilters, now: number): Record<string, string | number> {
	const ms = RANGES.find((r) => r.id === f.range)?.ms ?? RANGES[1].ms;
	const q: Record<string, string | number> = { from: now - ms };
	for (const k of ['agentId', 'sessionId', 'kind', 'status', 'source', 'model', 'q'] as const) if (f[k]) q[k] = f[k];
	return q;
}

export const activeFilterCount = (f: LogFilters): number => (['agentId', 'sessionId', 'kind', 'status', 'source', 'model'] as const).filter((k) => f[k]).length;

/** Does a live event (agent, session, kind, status, model) belong to the current view? `q` and `source` are not checked (events do not carry them; the refresh asks the server). */
export function matchesFilters(
	f: LogFilters,
	e: { agentId: string | null; sessionId: string | null; payload: Record<string, unknown> }
): boolean {
	if (f.agentId && e.agentId !== f.agentId) return false;
	if (f.sessionId && e.sessionId !== f.sessionId) return false;
	if (f.kind && e.payload.kind !== f.kind) return false;
	if (f.status && e.payload.status !== f.status) return false;
	if (f.model && !String(e.payload.model ?? '').toLowerCase().includes(f.model.toLowerCase())) return false;
	return true;
}

/** Output tokens per second of generation time (after the first chunk); null when it cannot be told. */
export function tokensPerSecond(c: Pick<ModelCallSummary, 'outputTokens' | 'durationMs' | 'firstChunkMs'>): number | null {
	if (!c.outputTokens) return null;
	const ms = c.durationMs - (c.firstChunkMs ?? 0);
	return ms > 0 ? (c.outputTokens / ms) * 1000 : null;
}

export function formatDuration(ms: number | null | undefined): string {
	if (ms === null || ms === undefined) return '—';
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
	return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export const formatSpeed = (tps: number | null): string => (tps === null ? '—' : `${tps < 10 ? tps.toFixed(1) : Math.round(tps)} tok/s`);

export const statusVariant = (s: ModelCallStatus): 'success' | 'destructive' | 'warning' => (s === 'ok' ? 'success' : s === 'error' ? 'destructive' : 'warning');

export function formatDateTime(ms: number): string {
	return teamDateTime(ms, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** A short label for a histogram bucket start. */
export function bucketLabel(ms: number, bucketMs: number): string {
	if (bucketMs >= 86_400_000) return formatDate(ms);
	const time = formatClock(ms);
	return bucketMs >= 3_600_000 * 6 ? `${formatDate(ms)} ${time}` : time;
}

/** A JSON column holding the marker of a value cut at the server's size cap. */
export function truncationOf(value: unknown): { bytes: number; preview: string } | null {
	const v = value as { _truncated?: unknown; bytes?: unknown; preview?: unknown } | null;
	if (v && typeof v === 'object' && v._truncated === true) {
		return { bytes: typeof v.bytes === 'number' ? v.bytes : 0, preview: typeof v.preview === 'string' ? v.preview : '' };
	}
	return null;
}

// ---- the prompt, readable -----------------------------------------------------------------------

export type PromptPart = { kind: 'text' | 'reasoning' | 'tool-call' | 'tool-result' | 'file' | 'other'; label?: string; text: string };
export type PromptMessage = { role: string; parts: PromptPart[] };

const asText = (v: unknown): string => {
	if (typeof v === 'string') return v;
	try {
		return JSON.stringify(v, null, 2) ?? String(v);
	} catch {
		return String(v);
	}
};

function partOf(p: unknown): PromptPart {
	if (typeof p === 'string') return { kind: 'text', text: p };
	const part = (p ?? {}) as Record<string, unknown>;
	switch (part.type) {
		case 'text':
			return { kind: 'text', text: asText(part.text) };
		case 'reasoning':
			return { kind: 'reasoning', text: asText(part.text) };
		case 'tool-call':
			return { kind: 'tool-call', label: String(part.toolName ?? 'tool'), text: asText(part.input) };
		case 'tool-result': {
			const out = part.output as { type?: unknown; value?: unknown } | undefined;
			const value = out && typeof out === 'object' && 'value' in out ? out.value : (out ?? part.result);
			return { kind: 'tool-result', label: String(part.toolName ?? 'tool'), text: asText(value) };
		}
		case 'file':
			return { kind: 'file', label: String(part.mediaType ?? 'file'), text: String(part.filename ?? '') || '[file]' };
		default:
			return { kind: 'other', label: String(part.type ?? 'part'), text: asText(part) };
	}
}

/** `request.options.prompt` as a list of messages with simple parts. Empty when the prompt is absent. */
export function promptMessages(options: unknown): PromptMessage[] {
	const prompt = (options as { prompt?: unknown } | null)?.prompt;
	if (!Array.isArray(prompt)) return [];
	return prompt.map((m) => {
		const msg = (m ?? {}) as { role?: unknown; content?: unknown };
		const content = msg.content;
		const parts = typeof content === 'string' ? [{ kind: 'text' as const, text: content }] : Array.isArray(content) ? content.map(partOf) : [partOf(content)];
		return { role: String(msg.role ?? 'unknown'), parts };
	});
}

export type OutputView = { text: string; reasoning: string; toolCalls: { toolCallId: string; toolName: string; input: unknown }[] };

export function outputOf(d: Pick<ModelCallDetail, 'output'>): OutputView {
	const o = (d.output ?? {}) as Partial<OutputView>;
	return {
		text: typeof o.text === 'string' ? o.text : '',
		reasoning: typeof o.reasoning === 'string' ? o.reasoning : '',
		toolCalls: Array.isArray(o.toolCalls) ? o.toolCalls : []
	};
}

/** Response headers, when the call has any. */
export const headersOf = (response: unknown): Record<string, string> => {
	const h = (response as { headers?: unknown } | null)?.headers;
	return h && typeof h === 'object' ? (h as Record<string, string>) : {};
};
