<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { tick, untrack } from 'svelte';
	import ArrowClockwiseIcon from 'phosphor-svelte/lib/ArrowClockwise';
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDown';
	import CaretUpIcon from 'phosphor-svelte/lib/CaretUp';
	import DownloadSimpleIcon from 'phosphor-svelte/lib/DownloadSimple';
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlass';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import TableIcon from 'phosphor-svelte/lib/Table';
	import TrashIcon from 'phosphor-svelte/lib/Trash';
	import UploadSimpleIcon from 'phosphor-svelte/lib/UploadSimple';
	import XIcon from 'phosphor-svelte/lib/X';
	import { api, ApiError } from '#lib/api/index.js';
	import { live } from '#lib/stores/live.svelte.js';
	import ConfirmDialog from '#lib/components/app/ConfirmDialog.svelte';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import Surface from '#lib/components/app/Surface.svelte';
	import AddRowDialog from '#lib/components/tables/AddRowDialog.svelte';
	import AggregatePanel from '#lib/components/tables/AggregatePanel.svelte';
	import ExportDialog from '#lib/components/tables/ExportDialog.svelte';
	import FilterPopover from '#lib/components/tables/FilterPopover.svelte';
	import ImportDialog from '#lib/components/tables/ImportDialog.svelte';
	import SchemaPanel from '#lib/components/tables/SchemaPanel.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import { formatTime } from '#lib/format.js';
	import {
		cellType,
		type ColumnType,
		type Condition,
		type DataTable,
		editText,
		type Filter,
		formatBytes,
		formatCell,
		type GridColumn,
		gridColumns,
		idsFilter,
		nextSort,
		parseValue,
		type Sort,
		sortBody,
		SYSTEM_FIELDS,
		type TableRecord
	} from '#lib/tables/tables.js';

	const SIZE = 50;
	const tableName = $derived(page.params.table ?? '');

	let table = $state<DataTable | null>(null);
	let tableError = $state('');
	let tab = $state<'rows' | 'summary' | 'schema'>('rows');

	let rows = $state<TableRecord[]>([]);
	let next = $state<string | null>(null);
	let total = $state(0);
	let loading = $state(true);
	let loadingMore = $state(false);
	let error = $state('');
	let req = 0;

	let filter = $state<Filter | undefined>(undefined);
	let filterCount = $state(0);
	let conditions = $state<Condition[]>([]);
	let filterJson = $state('');
	let sort = $state<Sort>(null);

	let selected = $state<string[]>([]);
	let confirmDelete = $state(false);
	let addOpen = $state(false);
	let importOpen = $state(false);
	let exportOpen = $state(false);

	let editing = $state<{ rowId: string; field: string } | null>(null);
	let draft = $state('');
	let savingCell = $state(false);

	const columns = $derived(gridColumns(table?.schema, rows));
	const fields = $derived([...columns.map((c) => c.name), ...SYSTEM_FIELDS]);
	const types = $derived(Object.fromEntries((table?.schema.columns ?? []).map((c) => [c.name, c.type])) as Record<string, ColumnType>);
	const numericFields = $derived([...columns.filter((c) => c.type === 'number').map((c) => c.name), '_version']);
	const allSelected = $derived(rows.length > 0 && rows.every((r) => selected.includes(r.id)));

	async function loadTable(): Promise<void> {
		try {
			table = await api.get('/tables/{table}', { params: { table: tableName } });
			tableError = '';
		} catch (e) {
			tableError = e instanceof Error ? e.message : 'Could not load the table';
		}
	}

	async function load(): Promise<void> {
		const mine = ++req;
		loading = true;
		error = '';
		try {
			const r = await api.post('/tables/{table}/query', { params: { table: tableName }, body: { ...(filter ? { filter } : {}), ...(sort ? { sort: sortBody(sort) } : {}), limit: SIZE } });
			if (mine !== req) return;
			rows = r.rows;
			next = r.next;
			total = r.total;
			selected = selected.filter((id) => r.rows.some((x) => x.id === id));
		} catch (e) {
			if (mine === req) error = e instanceof Error ? e.message : 'Could not load the rows';
		} finally {
			if (mine === req) loading = false;
		}
	}

	async function loadMore(): Promise<void> {
		if (!next || loadingMore || loading) return;
		const mine = req;
		loadingMore = true;
		try {
			const r = await api.post('/tables/{table}/query', { params: { table: tableName }, body: { ...(filter ? { filter } : {}), ...(sort ? { sort: sortBody(sort) } : {}), limit: SIZE, cursor: next } });
			if (mine !== req) return;
			const seen = new Set(rows.map((x) => x.id));
			rows = [...rows, ...r.rows.filter((x) => !seen.has(x.id))];
			next = r.next;
			total = r.total;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not load more rows';
		} finally {
			loadingMore = false;
		}
	}

	/** After a write: fresh counts and rows. */
	function refresh(): void {
		void loadTable();
		void load();
	}

	$effect(() => {
		void tableName;
		untrack(() => {
			table = null;
			tableError = '';
			filter = undefined;
			filterCount = 0;
			conditions = [];
			filterJson = '';
			sort = null;
			selected = [];
			editing = null;
			void loadTable();
			void load();
		});
	});

	// an agent, a script or another tab changed a table: refetch, unless a cell is being edited
	let seenRev = live.state.revs.tables;
	$effect(() => {
		const rev = live.state.revs.tables;
		const busy = editing !== null || savingCell; // tracked: a skipped refetch runs when the edit ends
		untrack(() => {
			if (rev === seenRev || busy) return;
			seenRev = rev;
			refresh();
		});
	});

	function applyFilter(f: Filter | undefined, count: number): void {
		filter = f;
		filterCount = count;
		void load();
	}
	function clearFilter(): void {
		conditions = [];
		filterJson = '';
		applyFilter(undefined, 0);
	}
	function sortBy(field: string): void {
		sort = nextSort(sort, field);
		void load();
	}

	function toggle(id: string, on: boolean): void {
		selected = on ? [...selected.filter((x) => x !== id), id] : selected.filter((x) => x !== id);
	}

	async function deleteSelected(): Promise<void> {
		const ids = [...selected];
		try {
			if (ids.length === 1) await api.delete('/tables/{table}/rows/{rowId}', { params: { table: tableName, rowId: ids[0] ?? '' } });
			else await api.post('/tables/{table}/delete', { params: { table: tableName }, body: { filter: idsFilter(ids) } });
			toast.success(`${ids.length} row${ids.length === 1 ? '' : 's'} deleted`);
			selected = [];
			refresh();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Could not delete the rows');
		}
	}

	// ------------------------------------------------------------ inline cell editing

	const cellKey = (rowId: string, field: string): string => `${rowId}:${field}`;

	function startEdit(r: TableRecord, col: GridColumn): void {
		if (savingCell) return;
		const v = r.data[col.name];
		editing = { rowId: r.id, field: col.name };
		draft = editText(v, cellType(col, v));
	}

	async function focusCell(rowId: string, field: string): Promise<void> {
		await tick();
		document.querySelector<HTMLElement>(`[data-cell="${CSS.escape(cellKey(rowId, field))}"]`)?.focus();
	}

	function cancelEdit(): void {
		const e = editing;
		editing = null;
		if (e) void focusCell(e.rowId, e.field);
	}

	function replaceRow(r: TableRecord): void {
		rows = rows.map((x) => (x.id === r.id ? r : x));
	}

	async function commitEdit(): Promise<void> {
		const e = editing;
		if (!e || savingCell) return;
		const r = rows.find((x) => x.id === e.rowId);
		const col = columns.find((c) => c.name === e.field);
		if (!r || !col) {
			editing = null;
			return;
		}
		const cur = r.data[e.field];
		const type = cellType(col, cur);
		if (draft === editText(cur, type)) {
			cancelEdit();
			return;
		}
		const p = parseValue(draft, type);
		if (!p.ok) {
			toast.error(`${e.field}: ${p.error}`);
			return;
		}
		const change = 'unset' in p ? { unset: [e.field] } : { set: { [e.field]: p.value } };
		savingCell = true;
		try {
			replaceRow(await api.patch('/tables/{table}/rows/{rowId}', { params: { table: tableName, rowId: r.id }, body: { change, ifVersion: r.version } }));
			editing = null;
			void focusCell(e.rowId, e.field);
		} catch (err) {
			if (err instanceof ApiError && err.code === 'STALE_ROW') {
				editing = null;
				toast.error('Somebody changed this row meanwhile. It was reloaded: check it and edit again.');
				try {
					replaceRow(await api.get('/tables/{table}/rows/{rowId}', { params: { table: tableName, rowId: r.id } }));
				} catch {
					void load();
				}
			} else toast.error(err instanceof Error ? err.message : 'Could not save the cell');
		} finally {
			savingCell = false;
		}
	}

	function cellKeys(ev: KeyboardEvent, r: TableRecord, col: GridColumn): void {
		if (ev.key === 'Enter' || ev.key === 'F2') {
			ev.preventDefault();
			startEdit(r, col);
		}
	}

	function editorKeys(ev: KeyboardEvent): void {
		if (ev.key === 'Enter') {
			ev.preventDefault();
			void commitEdit();
		} else if (ev.key === 'Escape') {
			ev.preventDefault();
			ev.stopPropagation();
			cancelEdit();
		}
	}

	const focusOnMount = (node: HTMLInputElement): void => {
		node.focus();
		node.select();
	};

	const description = $derived(
		table ? `${table.description ? `${table.description} · ` : ''}${table.rowCount.toLocaleString()} row${table.rowCount === 1 ? '' : 's'} · ${formatBytes(table.bytes)}` : 'A table of rows.'
	);
</script>

{#snippet sortHead(label: string, field: string, title?: string, mono = true)}
	<button type="button" class="inline-flex items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring {mono ? 'font-mono' : ''}" {title} onclick={() => sortBy(field)} aria-label="Sort by {label}">
		{label}
		{#if sort?.field === field}
			{#if sort.dir === 1}<CaretUpIcon class="size-3" />{:else}<CaretDownIcon class="size-3" />{/if}
		{/if}
	</button>
{/snippet}

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<PageHeader title={tableName} {description} breadcrumb={[{ label: 'Tables', href: '/tables' }]} backHref="/tables">
		{#if table}
			<Button size="sm" variant="outline" onclick={() => (importOpen = true)} aria-label="Import"><UploadSimpleIcon class="size-4" /><span class="hidden sm:inline">Import</span></Button>
			<Button size="sm" variant="outline" onclick={() => (exportOpen = true)} aria-label="Export"><DownloadSimpleIcon class="size-4" /><span class="hidden sm:inline">Export</span></Button>
			<Button size="sm" onclick={() => (addOpen = true)}><PlusIcon class="size-4" /> Add row</Button>
		{/if}
	</PageHeader>

	<PageBody size="full" class="gap-3">
		{#if tableError}
			<Empty.Root class="border border-dashed border-border">
				<Empty.Header><Empty.Title>Table not found</Empty.Title><Empty.Description>{tableError}</Empty.Description></Empty.Header>
				<Empty.Content><Button href="/tables" variant="outline">Back to tables</Button></Empty.Content>
			</Empty.Root>
		{:else if !table}
			<Skeleton class="h-10 w-64" />
			<Skeleton class="h-64 w-full" />
		{:else}
			<Tabs.Root bind:value={tab}>
				<Tabs.List variant="line" class="h-10 gap-4">
					<Tabs.Trigger value="rows">Rows</Tabs.Trigger>
					<Tabs.Trigger value="summary">Summary</Tabs.Trigger>
					<Tabs.Trigger value="schema">Schema</Tabs.Trigger>
				</Tabs.List>
			</Tabs.Root>

			{#if tab === 'rows'}
				<div class="flex flex-wrap items-center gap-2">
					<FilterPopover {fields} {types} active={filterCount} bind:conditions bind:json={filterJson} onApply={applyFilter} />
					{#if filterCount > 0}
						<Badge variant="secondary" class="gap-1 pr-1">
							Filtered
							<button type="button" class="rounded-sm p-0.5 hover:bg-accent" aria-label="Clear the filter" onclick={clearFilter}><XIcon class="size-3" /></button>
						</Badge>
					{/if}
					{#if sort}
						<Badge variant="secondary" class="gap-1 pr-1">
							Sorted by <span class="font-mono">{sort.field}</span> {sort.dir === 1 ? '↑' : '↓'}
							<button type="button" class="rounded-sm p-0.5 hover:bg-accent" aria-label="Back to creation order" onclick={() => { sort = null; void load(); }}><XIcon class="size-3" /></button>
						</Badge>
					{/if}
					<span class="text-xs text-muted-foreground" aria-live="polite">
						{#if !loading || rows.length}{total.toLocaleString()} row{total === 1 ? '' : 's'}{filterCount > 0 ? ' match' : ''}{rows.length < total ? `, ${rows.length.toLocaleString()} shown` : ''}{/if}
					</span>
					<span class="flex-1"></span>
					{#if selected.length}
						<Button size="sm" variant="destructive" onclick={() => (confirmDelete = true)}><TrashIcon class="size-4" /> Delete {selected.length}</Button>
					{/if}
					<Button variant="outline" size="icon-sm" aria-label="Refresh" title="Refresh" disabled={loading} onclick={refresh}>
						{#if loading}<Spinner class="size-4" />{:else}<ArrowClockwiseIcon class="size-4" />{/if}
					</Button>
				</div>

				{#if error && rows.length === 0}
					<p class="text-sm text-destructive-text" role="alert">{error} <button class="underline underline-offset-4" onclick={() => void load()}>Retry</button></p>
				{:else if loading && rows.length === 0}
					<div class="flex flex-col gap-2">{#each [0, 1, 2, 3, 4] as n (n)}<Skeleton class="h-9 w-full" />{/each}</div>
				{:else if rows.length === 0}
					<Empty.Root class="border border-dashed border-border">
						<Empty.Header>
							<Empty.Media variant="icon">{#if filterCount > 0}<MagnifyingGlassIcon />{:else}<TableIcon />{/if}</Empty.Media>
							<Empty.Title>{filterCount > 0 ? 'No rows match' : 'No rows yet'}</Empty.Title>
							<Empty.Description>{filterCount > 0 ? 'Change or clear the filter.' : 'Add a row by hand, import a CSV or JSON file from the library, or let an agent fill it.'}</Empty.Description>
						</Empty.Header>
						<Empty.Content>
							{#if filterCount > 0}
								<Button size="sm" variant="outline" onclick={clearFilter}>Clear the filter</Button>
							{:else}
								<div class="flex gap-2">
									<Button size="sm" onclick={() => (addOpen = true)}><PlusIcon class="size-4" /> Add row</Button>
									<Button size="sm" variant="outline" onclick={() => (importOpen = true)}><UploadSimpleIcon class="size-4" /> Import</Button>
								</div>
							{/if}
						</Empty.Content>
					</Empty.Root>
				{:else}
					<Surface class="overflow-hidden {loading ? 'opacity-60' : ''}">
						<div class="max-h-[calc(100dvh-15rem)] overflow-auto" data-testid="table-grid">
							<table class="w-max min-w-full border-collapse text-[13px]">
								<thead>
									<tr class="border-b border-border">
										<th class="sticky top-0 left-0 z-20 w-9 bg-card px-3 py-2">
											<Checkbox checked={allSelected} indeterminate={!allSelected && selected.length > 0} onCheckedChange={(v) => (selected = v === true ? rows.map((r) => r.id) : [])} aria-label="Select all loaded rows" />
										</th>
										<th class="sticky top-0 z-10 bg-card px-3 py-2 text-left text-[12.5px] font-medium whitespace-nowrap text-muted-foreground">{@render sortHead('_id', '_id', 'Row id (sorts by creation time)')}</th>
										{#each columns as c (c.name)}
											<th class="sticky top-0 z-10 bg-card px-3 py-2 text-left text-[12.5px] font-medium whitespace-nowrap text-muted-foreground {c.type === 'number' ? 'text-right' : ''}">
												{@render sortHead(c.name, c.name, c.column ? `${c.type}${c.column.required ? ', required' : ''}${c.column.indexed ? ', indexed' : ''}${c.column.description ? ` — ${c.column.description}` : ''}` : 'Not a column of the schema')}
												{#if !c.column}<span class="ml-0.5 text-[10px] text-muted-foreground/70" title="Not a column of the schema">*</span>{/if}
											</th>
										{/each}
										<th class="sticky top-0 z-10 bg-card px-3 py-2 text-left text-[12.5px] font-medium whitespace-nowrap text-muted-foreground">{@render sortHead('Updated', '_updatedAt', undefined, false)}</th>
									</tr>
								</thead>
								<tbody>
									{#each rows as r (r.id)}
										{@const isSel = selected.includes(r.id)}
										<tr class="group border-b border-border last:border-b-0 hover:bg-[color-mix(in_srgb,var(--muted)_50%,var(--card))] {isSel ? 'bg-[color-mix(in_srgb,var(--brand)_7%,var(--card))]' : ''}">
											<td class="sticky left-0 z-[5] bg-card px-3 py-1.5 group-hover:bg-[color-mix(in_srgb,var(--muted)_50%,var(--card))]">
												<Checkbox checked={isSel} onCheckedChange={(v) => toggle(r.id, v === true)} aria-label="Select row {r.id}" />
											</td>
											<td class="px-3 py-1.5 font-mono text-xs whitespace-nowrap text-muted-foreground" title="{r.id} · version {r.version} · by {r.updatedBy}">…{r.id.slice(-8)}</td>
											{#each columns as c (c.name)}
												{@const v = r.data[c.name]}
												{@const isEditing = editing?.rowId === r.id && editing.field === c.name}
												{#if isEditing}
													<td class="p-0.5">
														<input
															use:focusOnMount
															bind:value={draft}
															class="h-8 w-full min-w-40 rounded-md border border-ring bg-background px-2 text-[13px] outline-none {cellType(c, v) === 'json' ? 'font-mono text-xs' : ''}"
															aria-label="Edit {c.name}"
															placeholder={cellType(c, v) === 'boolean' ? 'true / false' : 'empty = no value'}
															disabled={savingCell}
															onkeydown={editorKeys}
															onblur={() => void commitEdit()}
														/>
													</td>
												{:else}
													<td
														data-cell={cellKey(r.id, c.name)}
														tabindex="0"
														class="max-w-72 cursor-text truncate px-3 py-1.5 whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset {typeof v === 'number' ? 'text-right font-mono tabular-nums' : ''} {typeof v === 'boolean' || (v !== null && typeof v === 'object') ? 'font-mono text-xs' : ''} {v === null ? 'text-muted-foreground italic' : ''}"
														title={formatCell(v)}
														ondblclick={() => startEdit(r, c)}
														onkeydown={(ev) => cellKeys(ev, r, c)}
													>{v === null ? 'null' : formatCell(v)}</td>
												{/if}
											{/each}
											<td class="px-3 py-1.5 text-xs whitespace-nowrap text-muted-foreground" title={new Date(r.updatedAt).toLocaleString()}>{formatTime(r.updatedAt)}</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					</Surface>
					<div class="flex min-h-10 flex-wrap items-center justify-center gap-3">
						{#if next}
							<Button variant="ghost" size="sm" class="text-muted-foreground" disabled={loadingMore} onclick={() => void loadMore()}>
								{#if loadingMore}<Spinner />{/if}Load more
							</Button>
						{:else}
							<span class="text-xs text-muted-foreground">End of the rows</span>
						{/if}
						<span class="hidden text-xs text-muted-foreground sm:inline">Double-click a cell or press Enter to edit it; Escape cancels.</span>
					</div>
					{#if error}<p class="text-center text-xs text-destructive-text" role="alert">{error}</p>{/if}
				{/if}
			{:else if tab === 'summary'}
				<div class="max-w-5xl">
					<AggregatePanel table={tableName} {fields} {numericFields} {filter} />
				</div>
			{:else}
				<SchemaPanel
					{table}
					onSaved={(t) => {
						if (t.name !== tableName) void goto(`/tables/${encodeURIComponent(t.name)}`, { replaceState: true });
						else table = t;
					}}
					onDropped={() => void goto('/tables')}
				/>
			{/if}
		{/if}
	</PageBody>
</div>

{#if table}
	<AddRowDialog bind:open={addOpen} table={tableName} columns={columns} strict={table.schema.strict === true} onDone={refresh} />
	<ImportDialog bind:open={importOpen} table={tableName} {fields} onDone={refresh} />
	<ExportDialog bind:open={exportOpen} table={tableName} {filter} sort={sortBody(sort)} />
{/if}

<ConfirmDialog
	bind:open={confirmDelete}
	title="Delete {selected.length} row{selected.length === 1 ? '' : 's'}?"
	description="The selected rows are deleted from {tableName}. This cannot be undone."
	onConfirm={deleteSelected}
/>
