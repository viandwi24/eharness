// The state of a server-side table (search, filters, sort, page) as pure functions: what is sent
// to the server, what the URL holds, and the numbers a pagination bar shows. No Svelte here.

export const PAGE_SIZES = [10, 25, 50, 100] as const;

export type Order = 'asc' | 'desc';

export interface TableParams {
	q: string;
	sort: string | undefined;
	order: Order | undefined;
	/** 1-based. */
	page: number;
	limit: number;
	/** One value per filter ('' = not filtered). */
	filters: Record<string, string>;
}

/** What a table starts with (and what the URL omits). */
export interface TableDefaults {
	sort?: string | undefined;
	order?: Order | undefined;
	limit?: number;
	filters?: Record<string, string>;
}

export const initialParams = (d: TableDefaults = {}): TableParams => ({
	q: '',
	sort: d.sort,
	order: d.order,
	page: 1,
	limit: d.limit ?? 25,
	filters: { ...(d.filters ?? {}) }
});

export const totalPages = (total: number, limit: number): number => Math.max(1, Math.ceil(total / Math.max(1, limit)));

/** The page to show: never before the first or after the last one that has rows. */
export const clampPage = (page: number, total: number, limit: number): number => Math.min(Math.max(1, Math.floor(page) || 1), totalPages(total, limit));

/** "1 to 25 of 132" for a page; "No results" for none. */
export function rangeText(page: number, limit: number, total: number, shown: number): string {
	if (total === 0 || shown === 0) return 'No results';
	const from = (page - 1) * limit + 1;
	return `${from} to ${from + shown - 1} of ${total}`;
}

/** Clicking a header: a new column starts in `first` order, the same column flips. */
export function nextSort(p: Pick<TableParams, 'sort' | 'order'>, key: string, first: Order = 'asc'): { sort: string; order: Order } {
	if (p.sort === key) return { sort: key, order: p.order === 'asc' ? 'desc' : 'asc' };
	return { sort: key, order: first };
}

/** `aria-sort` of a header. */
export const ariaSort = (p: Pick<TableParams, 'sort' | 'order'>, key: string): 'ascending' | 'descending' | 'none' => (p.sort !== key ? 'none' : p.order === 'desc' ? 'descending' : 'ascending');

/** The query of a request: only what is set (`extra` is merged last, e.g. a fixed `level`). */
export function tableQuery(p: TableParams, extra: Record<string, string | number | undefined> = {}): Record<string, string | number> {
	const out: Record<string, string | number> = { page: p.page, limit: p.limit };
	if (p.q.trim() !== '') out.q = p.q.trim();
	if (p.sort !== undefined) out.sort = p.sort;
	if (p.order !== undefined) out.order = p.order;
	for (const [k, v] of Object.entries(p.filters)) if (v !== '') out[k] = v;
	for (const [k, v] of Object.entries(extra)) if (v !== undefined) out[k] = v;
	return out;
}

/** The numbers of a pagination bar: first, last, and a window around the current page. */
export function pageWindow(page: number, pages: number): Array<number | '…'> {
	if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
	const set = new Set([1, pages, page - 1, page, page + 1]);
	const nums = [...set].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
	const out: Array<number | '…'> = [];
	for (const n of nums) {
		const last = out.at(-1);
		if (typeof last === 'number' && n - last > 1) out.push('…');
		out.push(n);
	}
	return out;
}

/** Read the table state from a URL; anything unknown or invalid falls back to the defaults. */
export function paramsFromUrl(search: URLSearchParams, d: TableDefaults = {}): TableParams {
	const p = initialParams(d);
	p.q = search.get('q') ?? '';
	const sort = search.get('sort');
	if (sort !== null && /^[A-Za-z]{1,24}$/.test(sort)) p.sort = sort;
	const order = search.get('order');
	if (order === 'asc' || order === 'desc') p.order = order;
	const page = Number(search.get('page'));
	if (Number.isInteger(page) && page >= 1) p.page = page;
	const limit = Number(search.get('limit'));
	if ((PAGE_SIZES as readonly number[]).includes(limit)) p.limit = limit;
	for (const k of Object.keys(p.filters)) {
		const v = search.get(k);
		if (v !== null && /^[\w.-]{1,64}$/.test(v)) p.filters[k] = v;
	}
	return p;
}

/** The query string of a table state: only what differs from the defaults. */
export function searchOf(p: TableParams, d: TableDefaults = {}): string {
	const s = new URLSearchParams();
	if (p.q.trim() !== '') s.set('q', p.q.trim());
	if (p.sort !== d.sort || p.order !== d.order) {
		if (p.sort !== undefined) s.set('sort', p.sort);
		if (p.order !== undefined) s.set('order', p.order);
	}
	if (p.page !== 1) s.set('page', String(p.page));
	if (p.limit !== (d.limit ?? 25)) s.set('limit', String(p.limit));
	for (const [k, v] of Object.entries(p.filters)) if (v !== (d.filters?.[k] ?? '')) s.set(k, v);
	const text = s.toString();
	return text === '' ? '' : `?${text}`;
}

/** Are any search text or filter set (what "Clear filters" would reset)? */
export const isFiltered = (p: TableParams, d: TableDefaults = {}): boolean => p.q.trim() !== '' || Object.entries(p.filters).some(([k, v]) => v !== (d.filters?.[k] ?? ''));

/** `yes` / `no` filter values as the API wants them (`undefined` = not filtered). */
export const yesNo = (v: string | undefined): 'yes' | 'no' | undefined => (v === 'yes' || v === 'no' ? v : undefined);
