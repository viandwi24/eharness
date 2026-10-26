<script lang="ts">
	import { tick, untrack, type Snippet } from 'svelte';
	import ArrowsOutSimpleIcon from 'phosphor-svelte/lib/ArrowsOutSimple';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import { copyText } from '#lib/clipboard.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { sortDir, type SortRule } from '#lib/tables/filters.js';
	import {
		afterCommit,
		cellType,
		cellValue,
		columnWidth,
		type DateInput,
		displayCell,
		editable,
		editKey,
		fromDateInput,
		fullText,
		type GridColumn,
		gridKey,
		type Pos,
		type SaveResult,
		toDateInput
	} from '#lib/tables/grid.js';
	import { type ColumnType, editText, parseValue, type TableRecord } from '#lib/tables/tables.js';
	import { cn } from '#lib/utils.js';
	import ColumnHeader, { type ColumnAction } from './ColumnHeader.svelte';
	import JsonEditor from './JsonEditor.svelte';

	/**
	 * The spreadsheet grid: sticky header and row numbers, typed cells, inline editing and the
	 * keyboard. It owns no data: saves go through `onSave` (`undefined` clears the field). A save
	 * that answers `error` keeps the editor open; `stale` keeps it open with the typed value and a
	 * note, so Enter saves it over the reloaded row. A draft row (`draftId`) is a new row typed in
	 * place: the page hears when the cursor leaves it or Escape is pressed on it.
	 */
	let {
		rows,
		columns,
		selected = $bindable([]),
		editing = $bindable(false),
		sorts,
		canAddRow = true,
		hasMore = false,
		loadingMore = false,
		dim = false,
		draftId,
		cellErrors = {},
		onSave,
		onClear,
		onOpenRow,
		onColumnAction,
		onAddColumn,
		onNewRow,
		onLoadMore,
		onLeaveRow,
		onEscapeRow,
		empty
	}: {
		rows: TableRecord[];
		columns: GridColumn[];
		selected?: string[];
		editing?: boolean;
		sorts: SortRule[];
		canAddRow?: boolean;
		hasMore?: boolean;
		loadingMore?: boolean;
		dim?: boolean;
		/** The id of the draft row among `rows`, if one is being typed. */
		draftId?: string;
		/** Problems to show on cells, by `rowId:key` (red outline and tooltip). */
		cellErrors?: Record<string, string>;
		onSave: (row: TableRecord, field: string, value: unknown) => Promise<SaveResult>;
		onClear: (row: TableRecord, field: string) => void;
		onOpenRow: (row: TableRecord) => void;
		onColumnAction: (a: ColumnAction, col: GridColumn) => void;
		onAddColumn: () => void;
		onNewRow: () => void;
		onLoadMore: () => void;
		onLeaveRow?: (rowId: string) => void;
		onEscapeRow?: (rowId: string) => void;
		empty?: Snippet;
	} = $props();

	const NUM_W = 76;
	const ROW_H = 36;

	let scroller = $state<HTMLDivElement | null>(null);
	let sentinel = $state<HTMLDivElement | null>(null);
	let viewWidth = $state(0);

	let active = $state<{ rowId: string; key: string } | null>(null);
	type Edit = { rowId: string; key: string; type: ColumnType; draft: string; date: DateInput };
	let edit = $state<Edit | null>(null);
	let saving = $state(false);
	let jsonEdit = $state<{ rowId: string; key: string; text: string; valid: boolean; stale?: boolean } | null>(null);
	/** The cell whose save hit a newer version: its editor stays open with the typed value. */
	let staleAt = $state<string | null>(null);
	let lastClicked = -1;
	let prevRow: string | null = null;

	// tell the page when the cursor leaves a row (a draft row saves or shows what it lacks)
	$effect(() => {
		const id = active?.rowId ?? null;
		const was = prevRow;
		prevRow = id;
		if (was && was !== id) untrack(() => onLeaveRow?.(was));
	});

	$effect(() => {
		editing = edit !== null || jsonEdit !== null || saving;
	});

	const realRows = $derived(rows.filter((r) => r.id !== draftId));
	const allSelected = $derived(realRows.length > 0 && realRows.every((r) => selected.includes(r.id)));
	const pos = $derived.by((): Pos | null => {
		if (!active) return null;
		const a = active;
		const row = rows.findIndex((r) => r.id === a.rowId);
		const col = columns.findIndex((c) => c.key === a.key);
		return row < 0 || col < 0 ? null : { row, col };
	});
	const size = $derived({ rows: rows.length, cols: columns.length });
	const tableWidth = $derived(NUM_W + columns.reduce((n, c) => n + columnWidth(c), 0) + 44);

	const cellId = (rowId: string, key: string): string => `${rowId}:${key}`;

	function setActive(p: Pos): void {
		const r = rows[p.row];
		const c = columns[p.col];
		if (r && c) active = { rowId: r.id, key: c.key };
	}

	// keep the active cell in view (the header and the row numbers are sticky: see scroll-margin)
	$effect(() => {
		const a = active;
		if (!a || !scroller) return;
		void tick().then(() => scroller?.querySelector<HTMLElement>(`[data-cell="${CSS.escape(cellId(a.rowId, a.key))}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
	});

	// load the next page when the end of the rows comes into view
	$effect(() => {
		if (!scroller || !sentinel || !hasMore) return;
		const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && onLoadMore(), { root: scroller, rootMargin: '240px' });
		io.observe(sentinel);
		return () => io.disconnect();
	});

	function focusGrid(): void {
		scroller?.focus({ preventScroll: true });
	}

	/** A draft row became a real row: keep the cursor on it. */
	export function remapActive(from: string, to: string): void {
		prevRow = prevRow === from ? to : prevRow;
		if (active?.rowId === from) active = { rowId: to, key: active.key };
		if (edit?.rowId === from) edit = { ...edit, rowId: to };
		if (jsonEdit?.rowId === from) jsonEdit = { ...jsonEdit, rowId: to };
	}

	const focusEditor = (rowId: string, key: string): void => {
		void tick().then(() => scroller?.querySelector<HTMLInputElement>(`[data-cell="${CSS.escape(cellId(rowId, key))}"] input`)?.focus());
	};

	/** Make a cell active (and start editing it), e.g. the first cell of a row just added. */
	export async function focusCell(rowId: string, key: string | undefined, startEditing = false): Promise<void> {
		await tick();
		const k = key ?? columns.find((c) => editable(c))?.key;
		const row = rows.find((r) => r.id === rowId);
		const col = columns.find((c) => c.key === k);
		if (!row || !col) return;
		active = { rowId, key: col.key };
		focusGrid();
		if (startEditing && cellType(col, row.data[col.key]) !== 'boolean' && cellType(col, row.data[col.key]) !== 'json') startEdit(row, col);
	}

	function startEdit(row: TableRecord, col: GridColumn, text?: string): void {
		if (!editable(col) || saving) return;
		active = { rowId: row.id, key: col.key };
		const v = row.data[col.key];
		const type = cellType(col, v);
		if (type === 'boolean') {
			void toggle(row, col);
			return;
		}
		if (type === 'json') {
			jsonEdit = { rowId: row.id, key: col.key, text: v === undefined ? '' : JSON.stringify(v, null, 2), valid: true };
			return;
		}
		edit = { rowId: row.id, key: col.key, type, draft: text ?? editText(v, type), date: toDateInput(v) };
	}

	async function toggle(row: TableRecord, col: GridColumn): Promise<void> {
		if (!editable(col) || saving) return;
		saving = true;
		try {
			await onSave(row, col.key, row.data[col.key] !== true);
		} finally {
			saving = false;
		}
	}

	function sameValue(a: unknown, b: unknown): boolean {
		return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
	}

	async function commit(then: 'down' | 'up' | 'right' | 'left' | 'stay'): Promise<void> {
		const e = edit;
		if (!e || saving) return;
		const row = rows.find((r) => r.id === e.rowId);
		if (!row) {
			edit = null;
			return;
		}
		const cur = row.data[e.key];
		let value: unknown;
		if (e.type === 'date') {
			if (e.date.value === toDateInput(cur).value && e.date.mode === toDateInput(cur).mode) value = cur;
			else {
				const d = fromDateInput(e.date);
				if (e.date.value && d === null) {
					toast.error(`${e.key}: not a date`);
					return;
				}
				value = d ?? undefined;
			}
		} else {
			const p = parseValue(e.draft, e.type);
			if (!p.ok) {
				toast.error(`${e.key}: ${p.error}`);
				return;
			}
			value = 'unset' in p ? undefined : p.value;
		}
		const done = (): void => {
			edit = null;
			staleAt = null;
			if (pos && then !== 'stay') setActive(afterCommit(pos, then, size));
			focusGrid();
		};
		// after a conflict the reloaded value may equal the old one: Enter still saves what was typed
		if (sameValue(cur, value) && staleAt !== cellId(e.rowId, e.key)) {
			done();
			return;
		}
		saving = true;
		let res: SaveResult = 'error';
		try {
			res = await onSave(row, e.key, value);
		} finally {
			saving = false;
		}
		if (res === 'ok') done();
		else {
			if (res === 'stale') staleAt = cellId(e.rowId, e.key);
			focusEditor(e.rowId, e.key);
		}
	}

	function cancel(): void {
		const rowId = edit?.rowId;
		edit = null;
		staleAt = null;
		focusGrid();
		if (rowId && rowId === draftId) onEscapeRow?.(rowId);
	}

	function editorKeys(ev: KeyboardEvent): void {
		ev.stopPropagation();
		const a = editKey(ev);
		if (a.kind === 'none') return;
		ev.preventDefault();
		if (a.kind === 'cancel') cancel();
		else void commit(a.then);
	}

	async function saveJson(): Promise<void> {
		const j = jsonEdit;
		if (!j || !j.valid || saving) return;
		const row = rows.find((r) => r.id === j.rowId);
		if (!row) {
			jsonEdit = null;
			return;
		}
		const value = j.text.trim() ? (JSON.parse(j.text) as unknown) : undefined;
		if (sameValue(row.data[j.key], value) && !j.stale) {
			jsonEdit = null;
			return;
		}
		saving = true;
		try {
			const res = await onSave(row, j.key, value);
			if (res === 'ok') jsonEdit = null;
			else if (res === 'stale' && jsonEdit) jsonEdit.stale = true;
		} finally {
			saving = false;
		}
	}

	function gridKeys(ev: KeyboardEvent): void {
		if (edit || jsonEdit) return;
		if (ev.target !== scroller) return; // keys inside a checkbox, a button or a menu are theirs
		if (!pos) {
			if (rows.length && columns.length && /^(Arrow|Tab|Home|End|Enter)/.test(ev.key)) {
				ev.preventDefault();
				setActive({ row: 0, col: 0 });
			}
			return;
		}
		const row = rows[pos.row];
		const col = columns[pos.col];
		if (!row || !col) return;
		if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'c') {
			ev.preventDefault();
			void copyText(fullText(cellValue(row, col))).then((ok) => ok && toast.success('Copied'));
			return;
		}
		if (ev.key === 'Escape') {
			if (row.id === draftId) onEscapeRow?.(row.id);
			active = null;
			return;
		}
		const type = cellType(col, row.data[col.key]);
		const a = gridKey(pos, ev, size, type, editable(col));
		if (a.kind === 'none') return;
		ev.preventDefault();
		switch (a.kind) {
			case 'move':
				setActive(a.to);
				break;
			case 'edit':
				startEdit(row, col, a.text);
				break;
			case 'toggle':
				void toggle(row, col);
				break;
			case 'clear':
				if (row.data[col.key] !== undefined) onClear(row, col.key);
				break;
			case 'expand':
				onOpenRow(row);
				break;
		}
	}

	async function paste(ev: ClipboardEvent): Promise<void> {
		if (edit || jsonEdit || !pos || ev.target !== scroller) return;
		const row = rows[pos.row];
		const col = columns[pos.col];
		const text = ev.clipboardData?.getData('text/plain');
		if (!row || !col || text === undefined || !editable(col)) return;
		ev.preventDefault();
		const type = cellType(col, row.data[col.key]);
		const p = parseValue(type === 'string' ? text : text.trim(), type);
		if (!p.ok) {
			toast.error(`${col.key}: ${p.error}`);
			return;
		}
		saving = true;
		try {
			await onSave(row, col.key, 'unset' in p ? undefined : p.value);
		} finally {
			saving = false;
		}
	}

	function selectRow(id: string, index: number, on: boolean, shift: boolean): void {
		if (shift && lastClicked >= 0) {
			const [a, b] = [Math.min(lastClicked, index), Math.max(lastClicked, index)];
			const range = rows.slice(a, b + 1).map((r) => r.id);
			selected = on ? [...new Set([...selected, ...range])] : selected.filter((x) => !range.includes(x));
		} else selected = on ? [...selected.filter((x) => x !== id), id] : selected.filter((x) => x !== id);
		lastClicked = index;
	}

	const focusInput = (node: HTMLInputElement): void => {
		node.focus();
		if (node.type === 'text') {
			const n = node.value.length;
			node.setSelectionRange(n, n);
		}
	};

	const stickyHead = 'sticky top-0 z-20 h-9 border-b border-r border-border bg-[color-mix(in_srgb,var(--muted)_70%,var(--card))] p-0';
</script>

<div
	bind:this={scroller}
	bind:clientWidth={viewWidth}
	class={cn('relative min-h-0 flex-1 overflow-auto overscroll-contain outline-none', dim && 'opacity-60')}
	tabindex="0"
	role="grid"
	aria-label="Rows"
	aria-rowcount={rows.length}
	data-testid="table-grid"
	onkeydown={gridKeys}
	onpaste={(e) => void paste(e)}
>
	<table class="border-separate border-spacing-0 text-[13px]" style="table-layout: fixed; width: {tableWidth}px">
		<colgroup>
			<col style="width: {NUM_W}px" />
			{#each columns as c (c.key)}<col style="width: {columnWidth(c)}px" />{/each}
			<col style="width: 44px" />
		</colgroup>
		<thead>
			<tr>
				<th class="{stickyHead} left-0 z-30 px-2 text-left">
					<div class="flex h-full items-center gap-2 pl-1">
						<Checkbox checked={allSelected} indeterminate={!allSelected && selected.length > 0} onCheckedChange={(v) => (selected = v === true ? realRows.map((r) => r.id) : [])} aria-label="Select all loaded rows" disabled={!realRows.length} />
					</div>
				</th>
				{#each columns as c (c.key)}
					<th class={stickyHead} aria-label={c.label}>
						<ColumnHeader col={c} sort={sortDir(sorts, c.field)} onAction={onColumnAction} />
					</th>
				{/each}
				<th class="{stickyHead} border-r-0">
					<button type="button" class="flex h-full w-full items-center justify-center text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent" title="Add a field" aria-label="Add a field" onclick={onAddColumn}>
						<PlusIcon class="size-4" />
					</button>
				</th>
			</tr>
		</thead>
		<tbody>
			{#each rows as r, i (r.id)}
				{@const isSel = selected.includes(r.id)}
				{@const isDraftRow = r.id === draftId}
				<tr class="group/row" style="height: {ROW_H}px" aria-rowindex={i + 1} aria-selected={isSel}>
					<td
						class={cn(
							'sticky left-0 z-10 border-r border-b border-border p-0',
							isSel ? 'bg-[color-mix(in_srgb,var(--brand)_10%,var(--card))]' : 'bg-card group-hover/row:bg-[color-mix(in_srgb,var(--muted)_55%,var(--card))]'
						)}
					>
						<div class="flex h-full items-center pr-1 pl-3">
							{#if isDraftRow}
								<span class="rounded bg-brand-soft px-1 text-[10px] font-medium text-brand-text" title="Not saved yet: fill in the required fields">New</span>
							{:else}
							<span class={cn('flex w-6 items-center', !isSel && !selected.length && 'group-hover/row:hidden', (isSel || selected.length > 0) && 'hidden')}>
								<span class="text-xs text-muted-foreground tabular-nums">{i + 1}</span>
							</span>
							<span class={cn('w-6 items-center', isSel || selected.length > 0 ? 'flex' : 'hidden group-hover/row:flex')}>
								<button type="button" role="checkbox" aria-checked={isSel} aria-label="Select row {i + 1}" class="flex rounded-[5px] outline-none focus-visible:shadow-ring" onclick={(e) => selectRow(r.id, i, !isSel, e.shiftKey)}><Checkbox checked={isSel} tabindex={-1} aria-hidden="true" class="pointer-events-none" /></button>
							</span>
							{/if}
							<button
								type="button"
								class="ml-auto flex size-7 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none group-hover/row:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100"
								title="Open row"
								aria-label="Open row {i + 1}"
								onclick={() => onOpenRow(r)}
							>
								<ArrowsOutSimpleIcon class="size-3.5" />
							</button>
						</div>
					</td>
					{#each columns as c (c.key)}
						{@const v = isDraftRow && c.kind === 'system' ? undefined : cellValue(r, c)}
						{@const problem = cellErrors[cellId(r.id, c.key)]}
						{@const isStale = staleAt === cellId(r.id, c.key)}
						{@const type = cellType(c, v)}
						{@const isActive = active?.rowId === r.id && active.key === c.key}
						{@const isEditing = edit?.rowId === r.id && edit.key === c.key}
						<td
							data-cell={cellId(r.id, c.key)}
							style="scroll-margin-top: {ROW_H}px; scroll-margin-left: {NUM_W}px"
							class={cn(
								'relative border-r border-b border-border p-0 whitespace-nowrap',
								isEditing && isStale ? 'z-[15] overflow-visible' : 'overflow-hidden',
								isSel ? 'bg-[color-mix(in_srgb,var(--brand)_7%,var(--card))]' : isDraftRow ? 'bg-[color-mix(in_srgb,var(--brand)_4%,var(--card))]' : 'group-hover/row:bg-[color-mix(in_srgb,var(--muted)_40%,var(--card))]',
								isActive && 'outline-2 -outline-offset-2 outline-brand',
								problem && !isEditing && 'bg-destructive-soft outline-2 -outline-offset-2 outline-destructive',
								c.kind === 'system' && 'text-muted-foreground'
							)}
							onclick={() => {
								active = { rowId: r.id, key: c.key };
								if (!isEditing) focusGrid();
							}}
							ondblclick={() => startEdit(r, c)}
							title={problem && !isEditing ? problem : undefined}
							aria-invalid={problem ? true : undefined}
						>
							{#if isEditing && edit}
								{#if edit.type === 'date'}
									<input
										use:focusInput
										type={edit.date.mode === 'date' ? 'date' : 'datetime-local'}
										bind:value={edit.date.value}
										class="absolute inset-0 h-full w-full bg-background px-2.5 text-[13px] outline-2 -outline-offset-2 outline-brand"
										aria-label="Edit {c.label}"
										disabled={saving}
										onkeydown={editorKeys}
										onblur={() => void commit('stay')}
									/>
								{:else}
									<input
										use:focusInput
										type="text"
										inputmode={edit.type === 'number' ? 'decimal' : undefined}
										bind:value={edit.draft}
										class={cn('absolute inset-0 h-full w-full bg-background px-2.5 text-[13px] outline-2 -outline-offset-2 outline-brand', edit.type === 'number' && 'text-right tabular-nums')}
										aria-label="Edit {c.label}"
										placeholder={c.column?.required ? 'Required' : isDraftRow ? c.label : ''}
										disabled={saving}
										onkeydown={editorKeys}
										onblur={() => void commit('stay')}
									/>
								{/if}
								{#if saving}<Spinner class="absolute top-2.5 right-2 size-3.5" />{/if}
								{#if isStale}
									<div role="status" class="absolute top-full left-0 z-30 mt-1 w-72 rounded-md border border-warning/40 bg-popover px-2.5 py-1.5 text-xs whitespace-normal text-warning-text shadow-floating">
										This row changed; your value is kept — press Enter to save it over the new version, or Escape to drop it.
									</div>
								{/if}
							{:else if type === 'boolean' && c.kind !== 'system'}
								<div class="flex h-full items-center justify-center">
									<Checkbox checked={v === true} onCheckedChange={() => void toggle(r, c)} aria-label="{c.label}, row {i + 1}" tabindex={-1} />
								</div>
							{:else if v === undefined || v === null || v === ''}
								<div class="h-full"></div>
							{:else if type === 'json'}
								<div class="flex h-full items-center px-2" title={fullText(v)}>
									<span class="truncate rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{displayCell(v, 'json')}</span>
								</div>
							{:else}
								<div
									class={cn('flex h-full items-center px-2.5', type === 'number' && 'justify-end font-mono text-[12.5px] tabular-nums', c.system === 'id' && 'font-mono text-[11.5px]')}
									title={type === 'string' && String(v).length > 24 ? String(v) : type === 'date' ? String(v) : undefined}
								>
									<span class="truncate">{c.system === 'id' ? `…${String(v).slice(-8)}` : displayCell(v, type)}</span>
								</div>
							{/if}
						</td>
					{/each}
					<td class="border-b border-border {isSel ? 'bg-[color-mix(in_srgb,var(--brand)_7%,var(--card))]' : ''}"></td>
				</tr>
			{/each}
			{#if canAddRow}
				<tr style="height: {ROW_H}px">
					<td colspan={columns.length + 2} class="border-b border-border p-0">
						<button
							type="button"
							class="sticky left-0 flex h-[35px] items-center gap-2 px-4 text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
							style="width: {Math.min(viewWidth || tableWidth, tableWidth)}px"
							onclick={onNewRow}
						>
							<PlusIcon class="size-4" /> New row
						</button>
					</td>
				</tr>
			{/if}
		</tbody>
	</table>
	{#if !rows.length && empty}
		<div class="sticky left-0" style="width: {viewWidth}px">{@render empty()}</div>
	{/if}
	{#if hasMore}
		<div bind:this={sentinel} class="sticky left-0 flex h-12 items-center justify-center text-xs text-muted-foreground" style="width: {viewWidth}px">
			{#if loadingMore}<Spinner class="mr-2 size-3.5" />Loading more rows…{:else}<Button variant="ghost" size="xs" onclick={onLoadMore}>Load more</Button>{/if}
		</div>
	{/if}
</div>

<Dialog.Root
	open={jsonEdit !== null}
	onOpenChange={(o) => {
		if (!o) {
			jsonEdit = null;
			focusGrid();
		}
	}}
>
	<Dialog.Content elevation="floating" class="[&>*]:min-w-0 sm:max-w-lg">
		{#if jsonEdit}
			<Dialog.Header>
				<Dialog.Title>Edit {jsonEdit.key}</Dialog.Title>
				<Dialog.Description>Any JSON value: a list like ["a", "b"], an object like {'{ "x": 1 }'}, text in quotes. Empty clears the field.</Dialog.Description>
			</Dialog.Header>
			{#if jsonEdit.stale}<p role="status" class="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-xs text-warning-text">This row changed; your value is kept — press Save to write it over the new version.</p>{/if}
			<JsonEditor bind:value={jsonEdit.text} bind:valid={jsonEdit.valid} rows={10} label="Value of {jsonEdit.key}" onSubmit={() => void saveJson()} />
			<Dialog.Footer>
				<Button variant="ghost" onclick={() => (jsonEdit = null)}>Cancel</Button>
				<Button disabled={!jsonEdit.valid || saving} onclick={() => void saveJson()}>{#if saving}<Spinner />{/if}Save</Button>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
