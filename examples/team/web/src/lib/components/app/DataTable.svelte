<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { Order } from '#lib/channels/table-core.js';

	/** One column of a {@link DataTable}. `sort` is the name the server sorts by (omit = not sortable). */
	export interface Column<T> {
		id: string;
		header: string;
		sort?: string;
		/** The first order when the header is clicked. */
		firstOrder?: Order;
		numeric?: boolean;
		class?: string;
		cell: Snippet<[T]>;
		/** On a phone the row is a card: `title` is its heading, `hide` leaves the column out. */
		mobile?: 'title' | 'hide';
	}
</script>

<script lang="ts" generics="T">
	import { onMount } from 'svelte';
	import ArrowDownIcon from 'phosphor-svelte/lib/ArrowDown';
	import ArrowUpIcon from 'phosphor-svelte/lib/ArrowUp';
	import ArrowsDownUpIcon from 'phosphor-svelte/lib/ArrowsDownUp';
	import CaretLeftIcon from 'phosphor-svelte/lib/CaretLeft';
	import CaretRightIcon from 'phosphor-svelte/lib/CaretRight';
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlass';
	import XIcon from 'phosphor-svelte/lib/X';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { IsMobile } from '#lib/hooks/is-mobile.svelte.js';
	import { pollWhileVisible } from '#lib/hooks/poll.js';
	import { ariaSort, isFiltered, PAGE_SIZES, pageWindow, rangeText } from '#lib/channels/table-core.js';
	import type { ServerTable } from '#lib/channels/table.svelte.js';

	/**
	 * A server-side table: the search box, the filters, the sortable headers and the pagination all
	 * ask the server for the next page (see `ServerTable`); nothing is filtered or sorted here.
	 * Rows become stacked cards on a phone. A row opens its page by `onRowClick`, and its title
	 * cell holds a real link, so the keyboard reaches it too.
	 */
	let {
		table,
		columns,
		rowKey,
		label,
		onRowClick,
		filters,
		actions,
		empty,
		emptyFiltered = 'Nothing matches the search or the filters.',
		searchPlaceholder = 'Search',
		searchable = true,
		poll = true,
		testid
	}: {
		table: ServerTable<T>;
		columns: Column<T>[];
		rowKey: (row: T) => string;
		/** What the table lists, for screen readers ("Chats"). */
		label: string;
		onRowClick?: (row: T) => void;
		/** Filter chips and selects next to the search box. */
		filters?: Snippet;
		/** Buttons on the right of the toolbar. */
		actions?: Snippet;
		/** Shown when the list is empty and nothing is filtered. */
		empty?: Snippet;
		emptyFiltered?: string;
		searchPlaceholder?: string;
		searchable?: boolean;
		/** Look again every few seconds while the page is visible (for lists that change). */
		poll?: boolean;
		testid?: string;
	} = $props();

	const mobile = new IsMobile();
	const p = $derived(table.params);
	const items = $derived(table.items);
	const filtered = $derived(isFiltered(p));
	const heading = $derived(columns.find((c) => c.mobile === 'title') ?? columns[0]);
	const rest = $derived(columns.filter((c) => c !== heading && c.mobile !== 'hide'));

	onMount(() => {
		void table.load();
		const stop = poll ? pollWhileVisible(() => void table.load(true)) : () => undefined;
		return () => {
			stop();
			table.destroy();
		};
	});

	function clicked(e: MouseEvent, row: T): void {
		if (!onRowClick) return;
		// a button, link or field inside the row does its own thing
		if ((e.target as HTMLElement).closest('a, button, input, select, textarea, label, [role=switch]')) return;
		onRowClick(row);
	}
	function key(e: KeyboardEvent, row: T): void {
		if (onRowClick && e.key === 'Enter' && e.target === e.currentTarget) onRowClick(row);
	}
</script>

<div class="flex flex-col gap-3" data-testid={testid}>
	{#if searchable || filters || actions}
		<div class="flex flex-wrap items-center gap-2">
			{#if searchable}
				<div class="relative min-w-48 flex-1 sm:max-w-72">
					<MagnifyingGlassIcon class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
					<Input
						type="search"
						class="pl-8"
						placeholder={searchPlaceholder}
						aria-label="Search {label}"
						value={table.search}
						oninput={(e) => table.setSearch(e.currentTarget.value)}
						data-testid="table-search"
					/>
				</div>
			{/if}
			{@render filters?.()}
			{#if filtered}
				<Button size="sm" variant="ghost" onclick={() => table.clear()} data-testid="table-clear"><XIcon class="size-3.5" /> Clear</Button>
			{/if}
			{#if actions}<div class="ml-auto flex items-center gap-2">{@render actions()}</div>{/if}
		</div>
	{/if}

	{#if table.error && items === null}
		<div class="flex flex-wrap items-center gap-2 rounded-lg border border-border p-4 text-sm" role="alert" data-testid="table-error">
			<span class="text-destructive-text">{table.error}</span>
			<Button size="sm" variant="outline" onclick={() => void table.load()}>Try again</Button>
		</div>
	{:else if items === null}
		<div class="flex flex-col gap-2" aria-busy="true" aria-label="Loading {label}" data-testid="table-loading">
			{#each [0, 1, 2, 3] as i (i)}<Skeleton class="h-12 w-full rounded-lg" />{/each}
		</div>
	{:else if items.length === 0 && table.total === 0}
		{#if filtered || !empty}
			<p class="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground" data-testid="table-empty-filtered">{filtered ? emptyFiltered : 'Nothing here yet.'}</p>
		{:else}
			<div data-testid="table-empty">{@render empty()}</div>
		{/if}
	{:else}
		{#if table.error}<p class="text-xs text-destructive-text" role="alert">{table.error} <button class="underline underline-offset-4" onclick={() => void table.load()}>Try again</button></p>{/if}
		<div class="transition-opacity {table.loading ? 'opacity-60' : ''}" aria-busy={table.loading}>
			{#if mobile.current}
				<ul class="flex flex-col gap-2" aria-label={label}>
					{#each items as row (rowKey(row))}
						<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
						<li
							class="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-3 {onRowClick ? 'cursor-pointer hover:bg-muted/40' : ''}"
							onclick={(e) => clicked(e, row)}
							onkeydown={(e) => key(e, row)}
							data-testid="table-row"
						>
							<div class="min-w-0 text-sm font-medium">{@render heading?.cell(row)}</div>
							{#each rest as c (c.id)}
								<div class="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
									<span class="shrink-0">{c.header}:</span>
									<span class="min-w-0 break-words text-foreground">{@render c.cell(row)}</span>
								</div>
							{/each}
						</li>
					{/each}
				</ul>
			{:else}
				<div class="overflow-hidden rounded-lg border border-border bg-card">
					<Table.Root aria-label={label}>
						<Table.Header>
							<Table.Row class="hover:bg-transparent">
								{#each columns as c (c.id)}
									<Table.Head numeric={c.numeric} class={c.class} aria-sort={c.sort ? ariaSort(p, c.sort) : undefined}>
										{#if c.sort}
											{@const sort = c.sort}
											<button
												type="button"
												class="-mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
												onclick={() => table.sortBy(sort, c.firstOrder ?? 'asc')}
												data-testid="sort-{c.id}"
											>
												{c.header}
												{#if p.sort === sort}
													{#if p.order === 'desc'}<ArrowDownIcon class="size-3" />{:else}<ArrowUpIcon class="size-3" />{/if}
												{:else}
													<ArrowsDownUpIcon class="size-3 opacity-40" />
												{/if}
											</button>
										{:else}
											{c.header}
										{/if}
									</Table.Head>
								{/each}
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{#each items as row (rowKey(row))}
								<Table.Row class={onRowClick ? 'cursor-pointer' : ''} onclick={(e: MouseEvent) => clicked(e, row)} data-testid="table-row">
									{#each columns as c (c.id)}
										<Table.Cell numeric={c.numeric} class="whitespace-normal {c.class ?? ''}">{@render c.cell(row)}</Table.Cell>
									{/each}
								</Table.Row>
							{/each}
						</Table.Body>
					</Table.Root>
				</div>
			{/if}
		</div>

		<div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-muted-foreground" data-testid="table-pagination">
			<span aria-live="polite" data-testid="table-range">{rangeText(p.page, p.limit, table.total, items.length)}</span>
			<div class="flex flex-wrap items-center gap-3">
				<label class="flex items-center gap-1.5">
					Rows
					<NativeSelect size="sm" value={String(p.limit)} onchange={(e) => table.setLimit(Number((e.currentTarget as HTMLSelectElement).value))} aria-label="Rows per page" data-testid="table-limit">
						{#each PAGE_SIZES as n (n)}<NativeSelectOption value={String(n)}>{n}</NativeSelectOption>{/each}
					</NativeSelect>
				</label>
				{#if table.pages > 1}
					<nav class="flex items-center gap-1" aria-label="Pages of {label}">
						<Button size="icon-sm" variant="ghost" onclick={() => table.setPage(p.page - 1)} disabled={p.page <= 1} aria-label="Previous page"><CaretLeftIcon class="size-4" /></Button>
						{#each pageWindow(p.page, table.pages) as n, i (i)}
							{#if n === '…'}
								<span class="px-1" aria-hidden="true">…</span>
							{:else}
								<Button size="icon-sm" variant={n === p.page ? 'secondary' : 'ghost'} onclick={() => table.setPage(n)} aria-label="Page {n}" aria-current={n === p.page ? 'page' : undefined}>{n}</Button>
							{/if}
						{/each}
						<Button size="icon-sm" variant="ghost" onclick={() => table.setPage(p.page + 1)} disabled={p.page >= table.pages} aria-label="Next page"><CaretRightIcon class="size-4" /></Button>
					</nav>
				{/if}
			</div>
		</div>
	{/if}
</div>
