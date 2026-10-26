<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { tick, untrack } from 'svelte';
	import ChartBarIcon from 'phosphor-svelte/lib/ChartBar';
	import DotsThreeIcon from 'phosphor-svelte/lib/DotsThree';
	import DownloadSimpleIcon from 'phosphor-svelte/lib/DownloadSimple';
	import GearIcon from 'phosphor-svelte/lib/Gear';
	import ListBulletsIcon from 'phosphor-svelte/lib/ListBullets';
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlass';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import TableIcon from 'phosphor-svelte/lib/Table';
	import TrashIcon from 'phosphor-svelte/lib/Trash';
	import UploadSimpleIcon from 'phosphor-svelte/lib/UploadSimple';
	import XIcon from 'phosphor-svelte/lib/X';
	import { api, ApiError } from '#lib/api/index.js';
	import { live } from '#lib/stores/live.svelte.js';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import Surface from '#lib/components/app/Surface.svelte';
	import type { ColumnAction } from '#lib/components/tables/ColumnHeader.svelte';
	import ColumnDialog from '#lib/components/tables/ColumnDialog.svelte';
	import ColumnsMenu from '#lib/components/tables/ColumnsMenu.svelte';
	import ConfirmAction from '#lib/components/tables/ConfirmAction.svelte';
	import DataGrid from '#lib/components/tables/DataGrid.svelte';
	import ExportDialog from '#lib/components/tables/ExportDialog.svelte';
	import FieldsSheet from '#lib/components/tables/FieldsSheet.svelte';
	import FilterPopover, { type FilterState, noFilter } from '#lib/components/tables/FilterPopover.svelte';
	import ImportDialog from '#lib/components/tables/ImportDialog.svelte';
	import RecordSheet from '#lib/components/tables/RecordSheet.svelte';
	import SortPopover from '#lib/components/tables/SortPopover.svelte';
	import SummarizeSheet from '#lib/components/tables/SummarizeSheet.svelte';
	import TableSettingsDialog from '#lib/components/tables/TableSettingsDialog.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { conditionsFilter, describeCondition, searchFilter, sortBody, sortBy, type SortRule } from '#lib/tables/filters.js';
	import { type ColumnPrefs, discoverColumns, FIELD_NAME, type GridColumn, isVisible, parsePrefs, prefsKey, queryable, type SaveResult, searchFields, setVisible, toDateInput } from '#lib/tables/grid.js';
	import { changedSince, DRAFT_ID, draftRecord, errorsByField, firstDraftField, isDraft, missingRequired, requiredErrors } from '#lib/tables/draft.js';
	import { type ColumnDraft, combineFilters, type DataTable, draftOf, type Filter, formatBytes, idsFilter, schemaOf, type TableColumn, type TableRecord } from '#lib/tables/tables.js';

	const PAGE = 100;
	const tableName = $derived(page.params.table ?? '');

	let table = $state<DataTable | null>(null);
	let tableError = $state('');

	let rows = $state<TableRecord[]>([]);
	let next = $state<string | null>(null);
	let total = $state(0);
	let loading = $state(true);
	let loadingMore = $state(false);
	let error = $state('');
	let req = 0;

	let filterState = $state<FilterState>(noFilter());
	let filter = $state<Filter | undefined>(undefined);
	let search = $state('');
	let searchIn = $state('');
	let searchQuery = $state('');
	let sorts = $state<SortRule[]>([]);
	let prefs = $state<ColumnPrefs>({ hidden: [], shown: [] });
	let selected = $state<string[]>([]);
	let gridEditing = $state(false);
	let grid = $state<ReturnType<typeof DataGrid> | null>(null);

	let filterOpen = $state(false);
	let filterAddField = $state<string | null>(null);
	let sortOpen = $state(false);
	let fieldsOpen = $state(false);
	let summarizeOpen = $state(false);
	let importOpen = $state(false);
	let exportOpen = $state(false);
	let exportStart = $state<'all' | 'view' | 'selected'>('all');
	let settingsOpen = $state(false);
	let dropOpen = $state(false);
	let bulkDeleteOpen = $state(false);
	let columnOpen = $state(false);
	let columnInitial = $state<(ColumnDraft & { isNew?: boolean }) | null>(null);
	let deleteCol = $state<TableColumn | null>(null);
	let deleteColOpen = $state(false);
	let deleteColClear = $state(false);
	let recordOpen = $state(false);
	let recordId = $state<string | null>(null);
	let schemaBusy = $state(false);

	const allColumns = $derived(discoverColumns(table?.schema, rows));
	const visible = $derived(allColumns.filter((c) => isVisible(c, prefs)));
	const fieldCols = $derived(allColumns.filter((c) => c.kind !== 'system'));
	const queryCols = $derived(queryable(allColumns));
	const textFields = $derived(searchFields(allColumns));
	const extras = $derived(allColumns.filter((c) => c.kind === 'extra').map((c) => c.key));
	const searchF = $derived(searchFilter(searchQuery, searchIn ? [searchIn] : textFields));
	const viewFilter = $derived(combineFilters(filter, searchF));
	const recordRow = $derived(recordId ? (rows.find((r) => r.id === recordId) ?? null) : null);
	const recordIndex = $derived(recordRow ? rows.indexOf(recordRow) : -1);
	/** A new row being typed in the grid; it is created once every required field has a value. */
	let draft = $state<{ data: Record<string, unknown>; errors: Record<string, string>; creating: boolean; touched: boolean } | null>(null);
	const gridRows = $derived(draft ? [...rows, draftRecord(draft.data)] : rows);
	const cellErrors = $derived(draft ? Object.fromEntries(Object.entries(draft.errors).map(([k, m]) => [`${DRAFT_ID}:${k}`, m])) : {});
	let recordInitial = $state<Record<string, unknown> | undefined>(undefined);
	const hasView = $derived(!!viewFilter || sorts.length > 0);

	const message = (e: unknown, fallback: string): string => (e instanceof Error ? e.message : fallback);

	// ------------------------------------------------------------ loading

	async function loadTable(): Promise<void> {
		try {
			table = await api.get('/tables/{table}', { params: { table: tableName } });
			tableError = '';
		} catch (e) {
			tableError = message(e, 'Could not load the table');
		}
	}

	function body(limit: number, cursor?: string) {
		return { ...(viewFilter ? { filter: viewFilter } : {}), ...(sorts.length ? { sort: sortBody(sorts) } : {}), limit, ...(cursor ? { cursor } : {}) };
	}

	/** First page, or (keep) as many rows as are loaded now, for refreshes. */
	async function load(keep = false): Promise<void> {
		const mine = ++req;
		loading = true;
		try {
			const r = await api.post('/tables/{table}/query', { params: { table: tableName }, body: body(keep ? Math.min(1000, Math.max(PAGE, rows.length)) : PAGE) });
			if (mine !== req) return;
			rows = r.rows;
			next = r.next;
			total = r.total;
			error = '';
			selected = selected.filter((id) => r.rows.some((x) => x.id === id));
		} catch (e) {
			if (mine === req) error = message(e, 'Could not load the rows');
		} finally {
			if (mine === req) loading = false;
		}
	}

	async function loadMore(): Promise<void> {
		if (!next || loadingMore || loading) return;
		const mine = req;
		loadingMore = true;
		try {
			const r = await api.post('/tables/{table}/query', { params: { table: tableName }, body: body(PAGE, next) });
			if (mine !== req) return;
			const seen = new Set(rows.map((x) => x.id));
			rows = [...rows, ...r.rows.filter((x) => !seen.has(x.id))];
			next = r.next;
			total = r.total;
		} catch (e) {
			toast.error(message(e, 'Could not load more rows'));
		} finally {
			loadingMore = false;
		}
	}

	function refresh(): void {
		void loadTable();
		void load(true);
	}

	function readPrefs(name: string): ColumnPrefs {
		try {
			return parsePrefs(localStorage.getItem(prefsKey(name)));
		} catch {
			return { hidden: [], shown: [] };
		}
	}
	function savePrefs(p: ColumnPrefs): void {
		prefs = p;
		try {
			localStorage.setItem(prefsKey(tableName), JSON.stringify(p));
		} catch {
			// storage unavailable: the choice lasts until reload
		}
	}

	$effect(() => {
		const name = tableName;
		untrack(() => {
			table = null;
			tableError = '';
			rows = [];
			filterState = noFilter();
			filter = undefined;
			search = '';
			searchQuery = '';
			searchIn = '';
			sorts = [];
			selected = [];
			prefs = readPrefs(name);
			void loadTable();
			void load();
		});
	});

	// the search box waits for a pause in typing
	$effect(() => {
		const q = search;
		const t = setTimeout(() => {
			if (q !== untrack(() => searchQuery)) {
				searchQuery = q;
				void load();
			}
		}, 300);
		return () => clearTimeout(t);
	});

	// an agent, a script or another tab changed a table: refetch, unless a cell is being edited
	let seenRev = live.state.revs.tables;
	$effect(() => {
		const rev = live.state.revs.tables;
		const busy = gridEditing || schemaBusy; // tracked: a skipped refetch runs when the edit ends
		untrack(() => {
			if (rev === seenRev || busy) return;
			seenRev = rev;
			refresh();
		});
	});

	// ------------------------------------------------------------ rows

	function replaceRow(r: TableRecord): void {
		rows = rows.map((x) => (x.id === r.id ? r : x));
	}

	async function reloadRow(id: string): Promise<void> {
		try {
			replaceRow(await api.get('/tables/{table}/rows/{rowId}', { params: { table: tableName, rowId: id } }));
		} catch {
			void load(true);
		}
	}

	/** One field of one row, guarded by the version read. */
	async function patchRow(row: TableRecord, field: string, value: unknown): Promise<'ok' | 'stale' | 'error'> {
		const change = value === undefined ? { unset: [field] } : { set: { [field]: value } };
		try {
			replaceRow(await api.patch('/tables/{table}/rows/{rowId}', { params: { table: tableName, rowId: row.id }, body: { change, ifVersion: row.version } }));
			return 'ok';
		} catch (e) {
			if (e instanceof ApiError && e.code === 'STALE_ROW') {
				toast.warning('This row changed meanwhile', { description: 'It was reloaded with the new version. What you typed is kept in the cell.' });
				await reloadRow(row.id);
				return 'stale';
			}
			toast.error(message(e, 'Could not save'));
			return 'error';
		}
	}

	async function saveCell(row: TableRecord, field: string, value: unknown): Promise<SaveResult> {
		if (isDraft(row)) return saveDraftCell(field, value);
		return patchRow(row, field, value);
	}

	async function clearCell(row: TableRecord, field: string): Promise<void> {
		if (isDraft(row)) {
			void saveDraftCell(field, undefined);
			return;
		}
		const old = row.data[field];
		if ((await patchRow(row, field, undefined)) !== 'ok') return;
		toast(`Cleared ${field}`, {
			duration: 8000,
			action: {
				label: 'Undo',
				onClick: () => {
					const cur = rows.find((r) => r.id === row.id);
					if (cur) void patchRow(cur, field, old);
				}
			}
		});
	}

	/** "+ New row": a draft row at the end of the grid, the cursor in its first required field. */
	async function newRow(): Promise<void> {
		if (!draft) draft = { data: {}, errors: {}, creating: false, touched: false };
		await tick();
		const keys = visible.filter((c) => c.kind !== 'system').map((c) => c.key);
		void grid?.focusCell(DRAFT_ID, firstDraftField(table?.schema, keys, draft?.data), true);
	}

	async function saveDraftCell(field: string, value: unknown): Promise<SaveResult> {
		if (!draft) return 'error';
		const data = { ...draft.data };
		if (value === undefined) delete data[field];
		else data[field] = value;
		const errors = { ...draft.errors };
		delete errors[field];
		draft = { ...draft, data, errors, touched: true };
		// while the row is being created, the change is written right after (changedSince)
		if (!draft.creating && missingRequired(table?.schema, data).length === 0) void createDraft();
		return 'ok';
	}

	async function createDraft(): Promise<void> {
		if (!draft || draft.creating) return;
		const sent = { ...draft.data };
		draft = { ...draft, creating: true };
		try {
			const r = await api.post('/tables/{table}/rows', { params: { table: tableName }, body: { rows: [sent] } });
			const id = r.inserted[0];
			if (!id) throw new Error('The row was not created');
			const row = await api.get('/tables/{table}/rows/{rowId}', { params: { table: tableName, rowId: id } });
			const later = draft ? changedSince(sent, draft.data) : { set: {}, unset: [] };
			grid?.remapActive(DRAFT_ID, id);
			draft = null;
			rows = rows.some((x) => x.id === id) ? rows : [...rows, row];
			total += 1;
			if (Object.keys(later.set).length || later.unset.length) {
				try {
					replaceRow(await api.patch('/tables/{table}/rows/{rowId}', { params: { table: tableName, rowId: id }, body: { change: { ...(Object.keys(later.set).length ? { set: later.set } : {}), ...(later.unset.length ? { unset: later.unset } : {}) }, ifVersion: row.version } }));
				} catch (e) {
					toast.error(message(e, 'The row was added, but your last change could not be saved'));
				}
			}
			toast.success('Row added');
		} catch (e) {
			const msg = message(e, 'Could not add the row');
			if (draft) {
				const keys = visible.filter((c) => c.kind !== 'system').map((c) => c.key);
				draft = { ...draft, creating: false, errors: { ...draft.errors, ...errorsByField(msg, keys, firstDraftField(table?.schema, keys, draft.data)) } };
			}
			toast.error('The new row was not saved', { description: msg });
		}
	}

	/** The cursor left the draft row: an empty draft goes away; one that lacks a required value says so. */
	function leaveRow(rowId: string): void {
		if (rowId !== DRAFT_ID || !draft || draft.creating) return;
		if (!draft.touched && Object.keys(draft.data).length === 0) {
			draft = null;
			return;
		}
		const missing = missingRequired(table?.schema, draft.data);
		if (missing.length) {
			draft = { ...draft, errors: { ...draft.errors, ...requiredErrors(missing) } };
			toast.warning('The new row is not saved yet', { description: `Fill in ${missing.join(', ')} to save it. Escape on an empty row drops it.` });
		} else void createDraft();
	}

	function escapeRow(rowId: string): void {
		if (rowId === DRAFT_ID && draft && !draft.creating && Object.keys(draft.data).length === 0) draft = null;
	}

	async function deleteSelected(): Promise<string | null> {
		const ids = [...selected];
		try {
			const r = await api.post('/tables/{table}/delete', { params: { table: tableName }, body: { filter: idsFilter(ids) } });
			toast.success(`${r.deleted} row${r.deleted === 1 ? '' : 's'} deleted`);
			selected = [];
			refresh();
			return null;
		} catch (e) {
			return message(e, 'Could not delete the rows');
		}
	}

	function openRow(r: TableRecord): void {
		if (isDraft(r)) {
			// the full form for the row being typed, starting from what is in the grid
			recordId = null;
			recordInitial = draft ? { ...draft.data } : undefined;
		} else {
			recordId = r.id;
			recordInitial = undefined;
		}
		recordOpen = true;
	}

	// ------------------------------------------------------------ view: filter, search, sort, columns

	function applyFilter(s: FilterState, f: Filter | undefined): void {
		filterState = s;
		filter = f;
		void load();
	}

	function removeCondition(i: number): void {
		const conds = filterState.conditions.filter((_, j) => j !== i);
		filterState = { ...filterState, conditions: conds };
		// rebuild from what is left (they were valid when applied)
		const r = conditionsFilter(conds, Object.fromEntries(queryCols.map((c) => [c.field, c.type])), filterState.match);
		filter = r.ok ? r.filter : undefined;
		void load();
	}

	function clearView(): void {
		filterState = noFilter();
		filter = undefined;
		search = '';
		searchQuery = '';
		sorts = [];
		void load();
	}

	function setSorts(s: SortRule[]): void {
		sorts = s;
		void load();
	}

	const labelOf = (field: string): string => queryCols.find((c) => c.field === field)?.label ?? field;

	// ------------------------------------------------------------ schema

	async function saveSchema(columns: TableColumn[], strict: boolean = table?.schema.strict === true): Promise<string | null> {
		if (!table) return 'The table is not loaded';
		schemaBusy = true;
		try {
			table = await api.patch('/tables/{table}', { params: { table: table.id }, body: { schema: strict ? { columns, strict: true } : { columns } } });
			return null;
		} catch (e) {
			return message(e, 'Could not save the fields');
		} finally {
			schemaBusy = false;
		}
	}

	/** After renaming a field: move each row's value to the new name (in pages, until none is left). */
	async function moveValues(from: string, to: string): Promise<void> {
		let moved = 0;
		const id = toast.loading(`Moving values from ${from} to ${to}…`);
		try {
			for (let round = 0; round < 100; round++) {
				const page = await api.post('/tables/{table}/query', { params: { table: tableName }, body: { filter: { [from]: { $exists: true } }, limit: 200 } });
				if (!page.rows.length) break;
				let progressed = false;
				for (const r of page.rows) {
					try {
						await api.patch('/tables/{table}/rows/{rowId}', { params: { table: tableName, rowId: r.id }, body: { change: { set: { [to]: r.data[from] }, unset: [from] }, ifVersion: r.version } });
						moved++;
						progressed = true;
					} catch {
						// a row that changed meanwhile or fails the schema stays under the old name
					}
				}
				if (!progressed) break;
			}
			toast.success(`Moved ${moved.toLocaleString()} value${moved === 1 ? '' : 's'} to ${to}`, { id });
		} catch (e) {
			toast.error(message(e, 'Could not move the values'), { id });
		}
		refresh();
	}

	function openAddColumn(): void {
		columnInitial = null;
		columnOpen = true;
	}

	function draftFor(c: TableColumn): ColumnDraft {
		const d = draftOf(c);
		if (c.type === 'date' && typeof c.default === 'string') d.default = toDateInput(c.default).value;
		return d;
	}

	async function submitColumn(d: ColumnDraft, o: { oldName: string | null; move: boolean }): Promise<string | null> {
		if (!table) return 'The table is not loaded';
		const s = schemaOf([d], false);
		if (!s.ok) return s.errors.join('. ');
		const col = s.schema.columns[0] as TableColumn;
		const cols = [...table.schema.columns];
		const at = o.oldName === null ? -1 : cols.findIndex((c) => c.name === o.oldName);
		if (at >= 0) cols[at] = col;
		else cols.push(col);
		const problem = await saveSchema(cols);
		if (problem) return problem;
		toast.success(o.oldName ? `Field ${col.name} saved` : `Field ${col.name} added`);
		if (o.oldName && o.move) void moveValues(o.oldName, col.name);
		else void load(true);
		return null;
	}

	async function confirmDeleteColumn(): Promise<string | null> {
		if (!table || !deleteCol) return null;
		const name = deleteCol.name;
		const problem = await saveSchema(table.schema.columns.filter((c) => c.name !== name));
		if (problem) return problem;
		if (deleteColClear) {
			try {
				const r = await api.post('/tables/{table}/update', { params: { table: tableName }, body: { filter: { [name]: { $exists: true } }, change: { unset: [name] } } });
				toast.success(`Field ${name} deleted and cleared from ${r.updated.toLocaleString()} row${r.updated === 1 ? '' : 's'}`);
			} catch (e) {
				toast.error(message(e, 'The field was removed from the schema, but its values could not be cleared'));
			}
		} else toast.success(`Field ${name} removed from the schema`, { description: 'Rows keep their values; it now shows as a field not in the schema.' });
		void load(true);
		return null;
	}

	function columnAction(a: ColumnAction, col: GridColumn): void {
		switch (a) {
			case 'sortAsc':
			case 'sortDesc':
				setSorts(sortBy(sorts, col.field, a === 'sortAsc' ? 'asc' : 'desc'));
				break;
			case 'filter':
				filterAddField = col.field;
				filterOpen = true;
				break;
			case 'edit':
				if (col.column) {
					columnInitial = draftFor(col.column);
					columnOpen = true;
				}
				break;
			case 'addToSchema':
				columnInitial = { name: col.key, type: col.type, required: false, indexed: false, default: '', isNew: true };
				columnOpen = true;
				break;
			case 'hide':
				savePrefs(setVisible(prefs, col, false));
				toast(`${col.label} hidden`, { duration: 8000, action: { label: 'Undo', onClick: () => savePrefs(setVisible(prefs, col, true)) } });
				break;
			case 'delete':
				if (col.column) {
					deleteCol = col.column;
					deleteColClear = false;
					deleteColOpen = true;
				}
				break;
		}
	}

	async function moveColumn(i: number, delta: -1 | 1): Promise<void> {
		if (!table) return;
		const cols = [...table.schema.columns];
		const j = i + delta;
		if (j < 0 || j >= cols.length) return;
		[cols[i], cols[j]] = [cols[j] as TableColumn, cols[i] as TableColumn];
		const problem = await saveSchema(cols);
		if (problem) toast.error(problem);
	}

	async function setStrict(on: boolean): Promise<void> {
		if (!table) return;
		const problem = await saveSchema(table.schema.columns, on);
		if (problem) toast.error(problem);
		else toast.success(on ? 'Only these fields are allowed now' : 'Rows may hold other fields again');
	}

	async function drop(): Promise<string | null> {
		if (!table) return null;
		try {
			await api.delete('/tables/{table}', { params: { table: table.id } });
			toast.success(`Table ${table.name} deleted`);
			void goto('/tables');
			return null;
		} catch (e) {
			return message(e, 'Could not delete the table');
		}
	}

	const description = $derived(table ? table.description || `${table.rowCount.toLocaleString()} row${table.rowCount === 1 ? '' : 's'} · ${formatBytes(table.bytes)}` : '');
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<PageHeader title={tableName} {description} breadcrumb={[{ label: 'Tables', href: '/tables' }]} backHref="/tables">
		{#if table}
			<Button size="sm" variant="ghost" onclick={() => (importOpen = true)} aria-label="Import"><UploadSimpleIcon class="size-4" /><span class="hidden sm:inline">Import</span></Button>
			<Button
				size="sm"
				variant="ghost"
				onclick={() => {
					exportStart = hasView ? 'view' : 'all';
					exportOpen = true;
				}}
				aria-label="Export"><DownloadSimpleIcon class="size-4" /><span class="hidden sm:inline">Export</span></Button
			>
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button {...props} variant="ghost" size="icon-sm" aria-label="More table actions"><DotsThreeIcon class="size-4" weight="bold" /></Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content elevation="floating" align="end" class="w-52">
					<DropdownMenu.Item onSelect={() => (fieldsOpen = true)}><ListBulletsIcon />Fields</DropdownMenu.Item>
					<DropdownMenu.Item onSelect={() => (settingsOpen = true)}><GearIcon />Rename and describe</DropdownMenu.Item>
					<DropdownMenu.Separator />
					<DropdownMenu.Item variant="destructive" onSelect={() => (dropOpen = true)}><TrashIcon />Delete table</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		{/if}
	</PageHeader>

	<div class="flex min-h-0 min-w-0 flex-1 flex-col gap-2.5 p-3 md:p-4">
		{#if tableError}
			<Empty.Root class="border border-dashed border-border">
				<Empty.Header>
					<Empty.Media variant="icon"><TableIcon /></Empty.Media>
					<Empty.Title>Table not found</Empty.Title>
					<Empty.Description>{tableError}</Empty.Description>
				</Empty.Header>
				<Empty.Content><Button href="/tables" variant="outline">Back to tables</Button></Empty.Content>
			</Empty.Root>
		{:else if !table}
			<div class="flex gap-2"><Skeleton class="h-8 w-64" /><Skeleton class="h-8 w-20" /><Skeleton class="h-8 w-20" /></div>
			<Surface class="flex flex-col gap-0 overflow-hidden p-0">
				<Skeleton class="h-9 w-full rounded-none" />
				{#each [0, 1, 2, 3, 4, 5, 6] as i (i)}<div class="flex gap-3 border-t border-border px-3 py-2.5"><Skeleton class="h-4 w-8" /><Skeleton class="h-4 w-40" /><Skeleton class="h-4 w-24" /><Skeleton class="h-4 w-32" /></div>{/each}
			</Surface>
		{:else}
			<!-- toolbar -->
			{#if selected.length}
				<div class="flex min-h-8 flex-wrap items-center gap-2 rounded-lg bg-brand-soft px-2">
					<Button variant="ghost" size="icon-xs" aria-label="Clear the selection" onclick={() => (selected = [])}><XIcon /></Button>
					<span class="text-sm font-medium text-brand-text">{selected.length} selected</span>
					<span class="flex-1"></span>
					<Button
						size="sm"
						variant="ghost"
						onclick={() => {
							exportStart = 'selected';
							exportOpen = true;
						}}><DownloadSimpleIcon class="size-4" /> Export</Button
					>
					<Button size="sm" variant="destructive" onclick={() => (bulkDeleteOpen = true)}><TrashIcon class="size-4" /> Delete</Button>
				</div>
			{:else}
				<div class="flex flex-wrap items-center gap-2">
					<InputGroup.Root class="h-8 w-full sm:w-64">
						<InputGroup.Addon><MagnifyingGlassIcon class="size-4" /></InputGroup.Addon>
						<InputGroup.Input bind:value={search} placeholder={textFields.length ? 'Search' : 'No text fields to search'} disabled={!textFields.length} aria-label="Search rows" />
						{#if search}
							<InputGroup.Addon align="inline-end"><InputGroup.Button size="icon-xs" aria-label="Clear the search" onclick={() => (search = '')}><XIcon /></InputGroup.Button></InputGroup.Addon>
						{/if}
					</InputGroup.Root>
					{#if textFields.length > 1}
						<span class="hidden sm:contents"><NativeSelect
							bind:value={searchIn}
							size="sm"
							aria-label="Search in"
							class="w-36"
							onchange={() => {
								if (searchQuery) void load();
							}}
						>
							<NativeSelectOption value="">All text fields</NativeSelectOption>
							{#each textFields as f (f)}<NativeSelectOption value={f}>In {f}</NativeSelectOption>{/each}
						</NativeSelect></span>
					{/if}
					<FilterPopover bind:open={filterOpen} bind:addField={filterAddField} value={filterState} fields={queryCols} onApply={applyFilter} />
					<SortPopover bind:open={sortOpen} rules={sorts} fields={queryCols} onChange={setSorts} />
					<Button variant="outline" size="sm" onclick={() => (summarizeOpen = true)}><ChartBarIcon /><span class="hidden sm:inline">Summarize</span></Button>
					<ColumnsMenu columns={allColumns} {prefs} onToggle={(c, v) => savePrefs(setVisible(prefs, c, v))} onReset={() => savePrefs({ hidden: [], shown: [] })} />
					<span class="flex-1"></span>
					<Button size="sm" onclick={() => void newRow()}><PlusIcon class="size-4" /> New row</Button>
				</div>
			{/if}

			<!-- active filter and sort as chips -->
			{#if filterState.conditions.length || (filterState.mode === 'json' && filter) || sorts.length || searchQuery}
				<div class="flex flex-wrap items-center gap-1.5">
					{#if searchQuery}
						<span class="inline-flex h-6 items-center gap-1 rounded-full border border-border bg-card pr-1 pl-2.5 text-xs">“{searchQuery}”{searchIn ? ` in ${searchIn}` : ''}<button type="button" class="rounded-full p-0.5 hover:bg-accent" aria-label="Clear the search" onclick={() => (search = '')}><XIcon class="size-3" /></button></span>
					{/if}
					{#if filterState.mode === 'json' && filter}
						<span class="inline-flex h-6 items-center gap-1 rounded-full border border-brand/40 bg-brand-soft pr-1 pl-2.5 text-xs text-brand-text">
							<button type="button" onclick={() => (filterOpen = true)}>Custom filter (JSON)</button>
							<button type="button" class="rounded-full p-0.5 hover:bg-accent" aria-label="Remove the filter" onclick={() => applyFilter(noFilter(), undefined)}><XIcon class="size-3" /></button>
						</span>
					{/if}
					{#each filterState.conditions as c, i (i)}
						{#if i > 0}<span class="text-[11px] text-muted-foreground">{filterState.match === 'and' ? 'and' : 'or'}</span>{/if}
						<span class="inline-flex h-6 max-w-full items-center gap-1 rounded-full border border-brand/40 bg-brand-soft pr-1 pl-2.5 text-xs text-brand-text">
							<button type="button" class="truncate" onclick={() => (filterOpen = true)}>{describeCondition(c, labelOf(c.field))}</button>
							<button type="button" class="rounded-full p-0.5 hover:bg-accent" aria-label="Remove the condition" onclick={() => removeCondition(i)}><XIcon class="size-3" /></button>
						</span>
					{/each}
					{#each sorts as s (s.field)}
						<span class="inline-flex h-6 items-center gap-1 rounded-full border border-border bg-card pr-1 pl-2.5 text-xs">
							<button type="button" onclick={() => (sortOpen = true)}>{labelOf(s.field)} {s.dir === 'asc' ? '↑' : '↓'}</button>
							<button type="button" class="rounded-full p-0.5 hover:bg-accent" aria-label="Remove the sort" onclick={() => setSorts(sorts.filter((x) => x.field !== s.field))}><XIcon class="size-3" /></button>
						</span>
					{/each}
					<Button variant="ghost" size="xs" class="text-muted-foreground" onclick={clearView}>Clear all</Button>
				</div>
			{/if}

			<!-- the grid -->
			<Surface class="flex min-h-0 flex-1 flex-col overflow-hidden p-0">
				{#if error && rows.length === 0}
					<div class="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center" role="alert">
						<p class="max-w-md text-sm text-destructive-text">{error}</p>
						<div class="flex gap-2">
							<Button size="sm" variant="outline" onclick={() => void load()}>Try again</Button>
							{#if viewFilter}<Button size="sm" variant="ghost" onclick={clearView}>Clear filter and search</Button>{/if}
						</div>
					</div>
				{:else if loading && rows.length === 0 && !total}
					<div class="flex flex-col">
						<Skeleton class="h-9 w-full rounded-none" />
						{#each [0, 1, 2, 3, 4] as i (i)}<div class="flex gap-3 border-t border-border px-3 py-2.5"><Skeleton class="h-4 w-8" /><Skeleton class="h-4 w-40" /><Skeleton class="h-4 w-24" /></div>{/each}
					</div>
				{:else}
					<DataGrid
						bind:this={grid}
						rows={gridRows}
						draftId={draft ? DRAFT_ID : undefined}
						{cellErrors}
						onLeaveRow={leaveRow}
						onEscapeRow={escapeRow}
						columns={visible}
						bind:selected
						bind:editing={gridEditing}
						{sorts}
						hasMore={!!next}
						{loadingMore}
						dim={loading}
						onSave={saveCell}
						onClear={(r, f) => void clearCell(r, f)}
						onOpenRow={openRow}
						onColumnAction={columnAction}
						onAddColumn={openAddColumn}
						onNewRow={() => void newRow()}
						onLoadMore={() => void loadMore()}
					>
						{#snippet empty()}
							<div class="flex flex-col items-center gap-3 px-6 py-12 text-center">
								<span class="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">{#if viewFilter}<MagnifyingGlassIcon class="size-5" />{:else}<TableIcon class="size-5" />{/if}</span>
								<div>
									<p class="text-sm font-medium">{viewFilter ? 'No rows match' : 'No rows yet'}</p>
									<p class="text-sm text-muted-foreground">{viewFilter ? 'Try another search or filter.' : 'Add a row, import a CSV or JSON file, or ask an agent to fill it.'}</p>
								</div>
								{#if viewFilter}
									<Button size="sm" variant="outline" onclick={clearView}>Clear filter and search</Button>
								{:else}
									<div class="flex gap-2">
										<Button size="sm" onclick={() => void newRow()}><PlusIcon class="size-4" /> New row</Button>
										<Button size="sm" variant="outline" onclick={() => (importOpen = true)}><UploadSimpleIcon class="size-4" /> Import a file</Button>
									</div>
								{/if}
							</div>
						{/snippet}
					</DataGrid>
				{/if}
				<div class="flex h-9 shrink-0 items-center gap-3 border-t border-border px-3 text-xs text-muted-foreground">
					<span aria-live="polite" class="tabular-nums">
						{#if rows.length < total}Showing {rows.length.toLocaleString()} of {total.toLocaleString()} rows{:else}{total.toLocaleString()} row{total === 1 ? '' : 's'}{/if}{viewFilter ? ` (of ${table.rowCount.toLocaleString()})` : ''}
					</span>
					{#if loading}<Spinner class="size-3.5" />{/if}
					<span class="flex-1"></span>
					<span class="hidden lg:inline">Arrows move · Enter or double-click edits · Delete clears · Shift+Enter opens the row</span>
				</div>
			</Surface>
		{/if}
	</div>
</div>

{#if table}
	<RecordSheet
		bind:open={recordOpen}
		table={tableName}
		row={recordRow}
		initialData={recordInitial}
		number={recordIndex >= 0 ? recordIndex + 1 : undefined}
		columns={fieldCols}
		strict={table.schema.strict === true}
		onSaved={replaceRow}
		onCreated={() => {
			if (recordInitial) draft = null;
			refresh();
		}}
		onDeleted={(id) => {
			rows = rows.filter((r) => r.id !== id);
			total = Math.max(0, total - 1);
			selected = selected.filter((x) => x !== id);
		}}
		onPrev={recordIndex > 0 ? () => (recordId = rows[recordIndex - 1]?.id ?? recordId) : undefined}
		onNext={recordIndex >= 0 && recordIndex < rows.length - 1 ? () => (recordId = rows[recordIndex + 1]?.id ?? recordId) : undefined}
	/>
	<FieldsSheet
		bind:open={fieldsOpen}
		schema={table.schema}
		{extras}
		busy={schemaBusy}
		onMove={(i, d) => void moveColumn(i, d)}
		onEdit={(c) => {
			columnInitial = draftFor(c);
			columnOpen = true;
		}}
		onDelete={(c) => {
			deleteCol = c;
			deleteColClear = false;
			deleteColOpen = true;
		}}
		onAdd={openAddColumn}
		onAddExtra={(name) => {
			const col = allColumns.find((c) => c.key === name);
			columnInitial = { name, type: col?.type ?? 'string', required: false, indexed: false, default: '', isNew: true };
			columnOpen = true;
		}}
		onStrict={(on) => void setStrict(on)}
	/>
	<ColumnDialog bind:open={columnOpen} initial={columnInitial} taken={table.schema.columns.map((c) => c.name)} rowCount={table.rowCount} onSubmit={submitColumn} />
	<SummarizeSheet bind:open={summarizeOpen} table={tableName} fields={queryCols} filter={viewFilter} />
	<ImportDialog bind:open={importOpen} table={tableName} fields={fieldCols.map((c) => c.key).filter((k) => FIELD_NAME.test(k))} onDone={refresh} />
	<ExportDialog bind:open={exportOpen} table={tableName} filter={viewFilter} sort={sortBody(sorts)} {selected} {total} start={exportStart} />
	<TableSettingsDialog
		bind:open={settingsOpen}
		{table}
		onSaved={(t) => {
			if (t.name !== tableName) void goto(`/tables/${encodeURIComponent(t.name)}`, { replaceState: true });
			else table = t;
		}}
		onDrop={() => {
			settingsOpen = false;
			dropOpen = true;
		}}
	/>
	<ConfirmAction
		bind:open={dropOpen}
		title="Delete the table {table.name}?"
		description="The table and all its {table.rowCount.toLocaleString()} rows are deleted. Agents and scripts that use it will fail. This cannot be undone, except by restoring a backup."
		confirmLabel="Delete table"
		typeToConfirm={table.name}
		onConfirm={drop}
	/>
	<ConfirmAction
		bind:open={deleteColOpen}
		title="Delete the field {deleteCol?.name ?? ''}?"
		description="It is removed from the schema. The values rows already have stay in the rows (shown as a field not in the schema) unless you clear them too."
		confirmLabel="Delete field"
		option="Also clear its values from every row"
		bind:optionChecked={deleteColClear}
		onConfirm={confirmDeleteColumn}
	/>
	<ConfirmAction
		bind:open={bulkDeleteOpen}
		title="Delete {selected.length} row{selected.length === 1 ? '' : 's'}?"
		description="The selected rows are removed from {table.name}. This cannot be undone."
		confirmLabel="Delete rows"
		onConfirm={deleteSelected}
	/>
{/if}
