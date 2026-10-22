// Logs page state: the list (cursor paged), the histogram stats, live updates from `model-call`
// events and the open call. Framework-free so it is testable; the page wraps `state` in `$state`.
import type { ApiClient, ModelCallDetail, ModelCallStats, ModelCallSummary } from '../api/client';
import type { ActivityRecord } from 'eharness/client';
import { alignStart, bucketMsFor } from './charts';
import { type LogFilters, emptyFilters, matchesFilters, queryOf } from './logs';

export type LogsState = {
	filters: LogFilters;
	items: ModelCallSummary[];
	nextCursor: string | null;
	/** First page loading (skeleton) or later pages (button spinner). */
	loading: boolean;
	loadingMore: boolean;
	error: string | null;
	stats: ModelCallStats | null;
	statsError: string | null;
	/** Rows that arrived while the viewer was scrolled down. */
	newCount: number;
	detail: ModelCallDetail | null;
	detailLoading: boolean;
	detailError: string | null;
};

export const emptyLogsState = (): LogsState => ({
	filters: emptyFilters(),
	items: [],
	nextCursor: null,
	loading: true,
	loadingMore: false,
	error: null,
	stats: null,
	statsError: null,
	newCount: 0,
	detail: null,
	detailLoading: false,
	detailError: null
});

export type LogsDeps = {
	now?: () => number;
	pageSize?: number;
	/** Debounce of live refreshes (ms). */
	debounceMs?: number;
	setTimeout?: (fn: () => void, ms: number) => unknown;
};

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createLogsCore(api: ApiClient, state: LogsState, deps: LogsDeps = {}) {
	const now = deps.now ?? (() => Date.now());
	const size = deps.pageSize ?? 50;
	const debounce = deps.debounceMs ?? 300;
	const timer = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
	let listReq = 0;
	let statsReq = 0;
	let detailReq = 0;
	let topPending = false;

	const core = {
		state,

		/** Reload the list and the histogram for `filters` (page 1). */
		async load(filters: LogFilters): Promise<void> {
			state.filters = filters;
			state.newCount = 0;
			state.loading = true;
			state.error = null;
			void core.loadStats();
			const mine = ++listReq;
			try {
				const page = await api.get('/logs', { query: { ...queryOf(filters, now()), limit: size } as never });
				if (mine !== listReq) return;
				state.items = page.items;
				state.nextCursor = page.nextCursor;
			} catch (e) {
				if (mine !== listReq) return;
				state.error = message(e);
			} finally {
				if (mine === listReq) state.loading = false;
			}
		},

		async loadMore(): Promise<void> {
			if (!state.nextCursor || state.loadingMore || state.loading) return;
			const mine = listReq;
			state.loadingMore = true;
			try {
				const page = await api.get('/logs', { query: { ...queryOf(state.filters, now()), limit: size, cursor: state.nextCursor } as never });
				if (mine !== listReq) return;
				const seen = new Set(state.items.map((i) => i.id));
				state.items = [...state.items, ...page.items.filter((i) => !seen.has(i.id))];
				state.nextCursor = page.nextCursor;
			} catch (e) {
				state.error = message(e);
			} finally {
				state.loadingMore = false;
			}
		},

		async loadStats(): Promise<void> {
			const mine = ++statsReq;
			try {
				const t = now();
				const q = queryOf(state.filters, t);
				const bucketMs = bucketMsFor(state.filters.range);
				// the first bucket starts on a boundary (whole hours, local midnight) so labels read well
				const stats = await api.get('/logs/stats', { query: { ...q, from: alignStart(Number(q.from), bucketMs), to: t, bucketMs } as never });
				if (mine !== statsReq) return;
				state.stats = stats;
				state.statsError = null;
			} catch (e) {
				if (mine === statsReq) state.statsError = message(e);
			}
		},

		/** Prepend rows newer than the top of the list (live updates while the viewer is at the top). */
		async refreshTop(): Promise<void> {
			const mine = listReq;
			try {
				const page = await api.get('/logs', { query: { ...queryOf(state.filters, now()), limit: size } as never });
				if (mine !== listReq || state.loading) return;
				const seen = new Set(state.items.map((i) => i.id));
				const top = state.items[0];
				const fresh = page.items.filter((i) => !seen.has(i.id) && (!top || i.startedAt >= top.startedAt));
				if (fresh.length === 0) return;
				// a whole page of new rows: there may be a gap below it, so start over
				if (fresh.length === page.items.length && top) {
					await core.load(state.filters);
					return;
				}
				state.items = [...fresh, ...state.items];
			} catch {
				// the next event or a manual refresh retries
			}
		},

		/** A `model-call` event: prepend when the viewer is at the top, else count it. */
		onEvent(e: ActivityRecord, atTop: boolean): void {
			if (e.type !== 'model-call' || !matchesFilters(state.filters, e)) return;
			if (atTop) {
				if (topPending) return;
				topPending = true;
				timer(() => {
					topPending = false;
					void core.refreshTop();
					void core.loadStats();
				}, debounce);
			} else {
				state.newCount++;
			}
		},

		/** Show the rows that arrived while scrolled down. */
		async showNew(): Promise<void> {
			await core.load(state.filters);
		},

		/** Fetch one call with neighbours under the current filters. */
		async openDetail(id: string): Promise<void> {
			const mine = ++detailReq;
			state.detailLoading = true;
			state.detailError = null;
			if (state.detail?.id !== id) state.detail = null;
			try {
				const detail = await api.get('/logs/{id}', { params: { id }, query: queryOf(state.filters, now()) as never });
				if (mine === detailReq) state.detail = detail;
			} catch (e) {
				if (mine === detailReq) state.detailError = message(e);
			} finally {
				if (mine === detailReq) state.detailLoading = false;
			}
		},

		closeDetail(): void {
			detailReq++;
			state.detail = null;
			state.detailLoading = false;
			state.detailError = null;
		}
	};
	return core;
}

export type LogsCore = ReturnType<typeof createLogsCore>;
