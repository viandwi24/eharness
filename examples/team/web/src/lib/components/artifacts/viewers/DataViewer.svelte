<script lang="ts">
	import ArrowDownIcon from 'phosphor-svelte/lib/ArrowDown';
	import ArrowUpIcon from 'phosphor-svelte/lib/ArrowUp';
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlass';
	import { nextSort, toTable, view, type Sort, type Table as TableData } from '#lib/artifacts/data.js';
	import { loadText, type ViewerInput } from '#lib/artifacts/input.js';
	import { CodeBlock } from '#lib/components/ai/code-block/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import * as Table from '#lib/components/ui/table/index.js';

	/** CSV and JSON arrays as a table, sorted and filtered in the browser; other JSON as code. */
	let { input }: { input: ViewerInput } = $props();

	const CAP = 500;
	let raw = $state<string>();
	let error = $state('');
	let filter = $state('');
	let sort = $state<Sort>(null);

	const table = $derived<TableData | undefined>(raw === undefined ? undefined : toTable(raw, input.name));
	const rows = $derived(table ? view(table.rows, filter, sort) : []);

	$effect(() => {
		const i = input;
		raw = undefined;
		error = '';
		filter = '';
		sort = null;
		const ctl = new AbortController();
		loadText(i, ctl.signal).then(
			(t) => !ctl.signal.aborted && (raw = t),
			(e: unknown) => !ctl.signal.aborted && (error = e instanceof Error ? e.message : 'Could not load the data')
		);
		return () => ctl.abort();
	});
</script>

<div class="flex h-full min-h-0 flex-col">
	{#if error}
		<p class="p-4 text-sm text-destructive-text" role="alert">{error}</p>
	{:else if raw === undefined}
		<Skeleton class="m-4 h-40" />
	{:else if !table}
		<div class="h-full overflow-auto p-4"><CodeBlock code={raw} language={'json' as never} showLineNumbers /></div>
	{:else}
		<div class="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
			<div class="relative min-w-0 flex-1">
				<MagnifyingGlassIcon class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
				<Input bind:value={filter} placeholder="Filter rows" aria-label="Filter rows" class="h-8 pl-8" />
			</div>
			<span class="shrink-0 text-xs text-muted-foreground tabular-nums">{rows.length === table.rows.length ? `${rows.length} rows` : `${rows.length} of ${table.rows.length}`}</span>
		</div>
		<div class="min-h-0 flex-1 overflow-auto">
			<Table.Root>
				<Table.Header>
					<Table.Row>
						{#each table.columns as c, i (i)}
							<Table.Head aria-sort={sort?.col === i ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
								<button type="button" class="flex items-center gap-1 text-left font-medium hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" onclick={() => (sort = nextSort(sort, i))}>
									{c}
									{#if sort?.col === i}{#if sort.dir === 'asc'}<ArrowUpIcon class="size-3" />{:else}<ArrowDownIcon class="size-3" />{/if}{/if}
								</button>
							</Table.Head>
						{/each}
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each rows.slice(0, CAP) as r, ri (ri)}
						<Table.Row>
							{#each table.columns as _c, ci (ci)}<Table.Cell class="max-w-64 truncate" title={r[ci]}>{r[ci] ?? ''}</Table.Cell>{/each}
						</Table.Row>
					{:else}
						<Table.Row><Table.Cell colspan={table.columns.length} class="text-center text-muted-foreground">Nothing matches the filter.</Table.Cell></Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
			{#if rows.length > CAP}<p class="p-3 text-center text-xs text-muted-foreground">Showing the first {CAP} rows. Download the file for all of them.</p>{/if}
		</div>
	{/if}
</div>
