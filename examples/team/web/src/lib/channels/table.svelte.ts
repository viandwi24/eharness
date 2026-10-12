import { goto } from '$app/navigation';
import { page as route } from '$app/state';
import { clampPage, initialParams, nextSort, paramsFromUrl, searchOf, totalPages, type Order, type TableDefaults, type TableParams } from './table-core';

/** What every table endpoint returns. */
export interface TablePage<T> {
	items: T[];
	total: number;
	page: number;
	limit: number;
}

/**
 * The state of one server-side table: search text, filters, sort and page, the rows of the page
 * and the total, with loading and error. Every change fetches again from the server (nothing is
 * filtered or sorted in the browser). With `url`, the state lives in the query string, so a reload
 * or the back button returns to the same page of the same search.
 */
export class ServerTable<T> {
	items = $state<T[] | null>(null);
	total = $state(0);
	loading = $state(false);
	error = $state('');
	params = $state<TableParams>(initialParams());
	/** The search box as typed (the request waits for a pause). */
	search = $state('');

	#fetch: (p: TableParams) => Promise<TablePage<T>>;
	#defaults: TableDefaults;
	#url: boolean;
	#seq = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;

	constructor(fetcher: (p: TableParams) => Promise<TablePage<T>>, defaults: TableDefaults = {}, options: { url?: boolean } = {}) {
		this.#fetch = fetcher;
		this.#defaults = defaults;
		this.#url = options.url ?? true;
		this.params = this.#url ? paramsFromUrl(new URLSearchParams(route.url.searchParams.toString()), defaults) : initialParams(defaults);
		this.search = this.params.q;
	}

	get pages(): number {
		return totalPages(this.total, this.params.limit);
	}

	/** Fetch the current page. `quiet` (a poll) keeps the rows on screen and shows no spinner. */
	async load(quiet = false): Promise<void> {
		const mine = ++this.#seq;
		if (!quiet) this.loading = true;
		try {
			const r = await this.#fetch($state.snapshot(this.params));
			if (mine !== this.#seq) return;
			// the last page shrank (rows were removed): go back to the last one that exists
			const fit = clampPage(this.params.page, r.total, this.params.limit);
			if (fit !== this.params.page && r.total > 0) {
				this.params.page = fit;
				void this.load(quiet);
				return;
			}
			this.items = r.items;
			this.total = r.total;
			this.error = '';
		} catch (e) {
			if (mine === this.#seq) this.error = e instanceof Error ? e.message : 'Could not load the list';
		} finally {
			if (mine === this.#seq) this.loading = false;
		}
	}

	#changed(): void {
		if (this.#url && typeof window !== 'undefined') {
			const search = searchOf(this.params, this.#defaults);
			if (search !== window.location.search) void goto(`${window.location.pathname}${search}`, { replace: true, shallow: true });
		}
		void this.load();
	}

	setSearch(text: string): void {
		this.search = text;
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			if (this.params.q === text) return;
			this.params.q = text;
			this.params.page = 1;
			this.#changed();
		}, 300);
	}

	setFilter(key: string, value: string): void {
		if (this.params.filters[key] === value) return;
		this.params.filters[key] = value;
		this.params.page = 1;
		this.#changed();
	}

	sortBy(key: string, first: Order = 'asc'): void {
		const s = nextSort(this.params, key, first);
		this.params.sort = s.sort;
		this.params.order = s.order;
		this.params.page = 1;
		this.#changed();
	}

	setPage(page: number): void {
		this.params.page = clampPage(page, this.total, this.params.limit);
		this.#changed();
	}

	setLimit(limit: number): void {
		this.params.limit = limit;
		this.params.page = 1;
		this.#changed();
	}

	/** Back to no search and no filters. */
	clear(): void {
		clearTimeout(this.#timer);
		this.search = '';
		this.params.q = '';
		this.params.filters = { ...(this.#defaults.filters ?? {}) };
		this.params.page = 1;
		this.#changed();
	}

	destroy(): void {
		clearTimeout(this.#timer);
	}
}
