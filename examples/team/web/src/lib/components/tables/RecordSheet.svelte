<script lang="ts">
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDown';
	import CaretUpIcon from 'phosphor-svelte/lib/CaretUp';
	import CopyIcon from 'phosphor-svelte/lib/Copy';
	import TrashIcon from 'phosphor-svelte/lib/Trash';
	import { api, ApiError } from '#lib/api/index.js';
	import { copyText } from '#lib/clipboard.js';
	import { CodeBlock } from '#lib/components/ai/code-block/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import * as Sheet from '#lib/components/ui/sheet/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { type DateInput, fromDateInput, type GridColumn, toDateInput, TYPE_LABELS } from '#lib/tables/grid.js';
	import { type ColumnType, editText, inferType, parseValue, type TableRecord } from '#lib/tables/tables.js';
	import ConfirmAction from './ConfirmAction.svelte';
	import JsonEditor from './JsonEditor.svelte';
	import TypeIcon from './TypeIcon.svelte';

	/**
	 * One row as a form (every field by type), as raw JSON, and its details. `row` null adds a
	 * new row. Saving sends only what changed, guarded by the row's version.
	 */
	let {
		open = $bindable(false),
		table,
		row,
		initialData,
		number,
		columns,
		strict = false,
		onSaved,
		onCreated,
		onDeleted,
		onPrev,
		onNext
	}: {
		open?: boolean;
		table: string;
		row: TableRecord | null;
		/** For a new row: values to start the form with (a draft typed in the grid). */
		initialData?: Record<string, unknown>;
		/** The row's place in the grid (1-based), for the title. */
		number?: number;
		columns: GridColumn[];
		strict?: boolean;
		onSaved: (row: TableRecord) => void;
		onCreated: (id: string) => void;
		onDeleted: (id: string) => void;
		onPrev?: () => void;
		onNext?: () => void;
	} = $props();

	type Draft = { text: string; bool: '' | 'true' | 'false'; date: DateInput };
	let drafts = $state<Record<string, Draft>>({});
	let tab = $state('fields');
	let jsonText = $state('');
	let jsonValid = $state(true);
	let jsonEditing = $state(false);
	let busy = $state(false);
	let error = $state('');
	let confirmDelete = $state(false);
	let loadedFor = '';

	const fields = $derived(columns.filter((c) => c.kind !== 'system'));
	const typeOf = (c: GridColumn): ColumnType => (c.kind === 'extra' && row ? inferType(row.data[c.key]) : c.type);

	function init(r: TableRecord | null): void {
		const next: Record<string, Draft> = {};
		for (const c of fields) {
			const v = r ? r.data[c.key] : initialData?.[c.key];
			const t = typeOf(c);
			next[c.key] = { text: t === 'json' ? (v === undefined ? '' : JSON.stringify(v, null, 2)) : editText(v, t), bool: v === true ? 'true' : v === false ? 'false' : '', date: toDateInput(v) };
		}
		drafts = next;
		jsonText = JSON.stringify(r?.data ?? initialData ?? {}, null, 2);
		jsonEditing = false;
		error = '';
	}

	// a new row or another row: fresh form (not on every live update of the same row, which would clobber typing)
	$effect(() => {
		if (!open) {
			loadedFor = '';
			return;
		}
		const key = row ? row.id : 'new';
		if (key === loadedFor) return;
		loadedFor = key;
		tab = 'fields';
		init(row);
	});

	/** The form's value of a field, or an error. `undefined` = no value. */
	function valueOf(c: GridColumn): { ok: true; value: unknown } | { ok: false; error: string } {
		const d = drafts[c.key];
		if (!d) return { ok: true, value: row?.data[c.key] };
		const t = typeOf(c);
		if (t === 'boolean') return { ok: true, value: d.bool === '' ? undefined : d.bool === 'true' };
		if (t === 'date') {
			const cur = row?.data[c.key];
			const was = toDateInput(cur);
			if (row && was.value === d.date.value && was.mode === d.date.mode) return { ok: true, value: cur };
			const v = fromDateInput(d.date);
			if (d.date.value && v === null) return { ok: false, error: `${c.key}: not a date` };
			return { ok: true, value: v ?? undefined };
		}
		if (t === 'json') {
			if (!d.text.trim()) return { ok: true, value: undefined };
			try {
				return { ok: true, value: JSON.parse(d.text) };
			} catch {
				return { ok: false, error: `${c.key}: not valid JSON` };
			}
		}
		const p = parseValue(d.text, t);
		if (!p.ok) return { ok: false, error: `${c.key}: ${p.error}` };
		return { ok: true, value: 'unset' in p ? undefined : p.value };
	}

	const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

	async function patch(change: { set?: Record<string, unknown>; unset?: string[] }): Promise<void> {
		if (!row) return;
		try {
			const saved = await api.patch('/tables/{table}/rows/{rowId}', { params: { table, rowId: row.id }, body: { change, ifVersion: row.version } });
			toast.success('Row saved');
			onSaved(saved);
			init(saved);
		} catch (e) {
			if (e instanceof ApiError && e.code === 'STALE_ROW') {
				error = 'Someone changed this row while you were editing. It was reloaded with their changes — check and save again.';
				try {
					const fresh = await api.get('/tables/{table}/rows/{rowId}', { params: { table, rowId: row.id } });
					onSaved(fresh);
					init(fresh);
					error = 'Someone changed this row while you were editing. It was reloaded with their changes — check and save again.';
				} catch {
					// the row may be gone: keep the message
				}
			} else error = e instanceof Error ? e.message : 'Could not save the row';
		}
	}

	async function saveFields(): Promise<void> {
		error = '';
		const values: Record<string, unknown> = {};
		for (const c of fields) {
			const v = valueOf(c);
			if (!v.ok) {
				error = v.error;
				return;
			}
			values[c.key] = v.value;
		}
		busy = true;
		try {
			if (!row) {
				const data = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
				const r = await api.post('/tables/{table}/rows', { params: { table }, body: { rows: [data] } });
				toast.success('Row added');
				open = false;
				onCreated(r.inserted[0] ?? '');
				return;
			}
			const set: Record<string, unknown> = {};
			const unset: string[] = [];
			for (const [k, v] of Object.entries(values)) {
				if (same(row.data[k], v)) continue;
				if (v === undefined) unset.push(k);
				else set[k] = v;
			}
			if (!unset.length && !Object.keys(set).length) {
				toast('Nothing changed');
				return;
			}
			await patch({ ...(Object.keys(set).length ? { set } : {}), ...(unset.length ? { unset } : {}) });
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not save the row';
		} finally {
			busy = false;
		}
	}

	async function saveJson(): Promise<void> {
		error = '';
		let data: unknown;
		try {
			data = JSON.parse(jsonText);
		} catch {
			error = 'The JSON is not valid.';
			return;
		}
		if (typeof data !== 'object' || data === null || Array.isArray(data)) {
			error = 'A row is a JSON object, like { "name": "Ann" }.';
			return;
		}
		const next = data as Record<string, unknown>;
		busy = true;
		try {
			if (!row) {
				const r = await api.post('/tables/{table}/rows', { params: { table }, body: { rows: [next] } });
				toast.success('Row added');
				open = false;
				onCreated(r.inserted[0] ?? '');
				return;
			}
			const set = Object.fromEntries(Object.entries(next).filter(([k, v]) => !same(row.data[k], v)));
			const unset = Object.keys(row.data).filter((k) => !(k in next));
			if (!unset.length && !Object.keys(set).length) {
				jsonEditing = false;
				return;
			}
			await patch({ ...(Object.keys(set).length ? { set } : {}), ...(unset.length ? { unset } : {}) });
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not save the row';
		} finally {
			busy = false;
		}
	}

	async function remove(): Promise<string | null> {
		if (!row) return null;
		try {
			await api.delete('/tables/{table}/rows/{rowId}', { params: { table, rowId: row.id } });
			toast.success('Row deleted');
			const id = row.id;
			open = false;
			onDeleted(id);
			return null;
		} catch (e) {
			return e instanceof Error ? e.message : 'Could not delete the row';
		}
	}

	const when = (ms: number): string => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
</script>

<Sheet.Root bind:open>
	<Sheet.Content side="right" class="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
		<Sheet.Header class="flex-row items-center gap-2 pr-12 pb-3">
			<div class="min-w-0 flex-1">
				<Sheet.Title>{row ? `Row ${number ?? ''}` : 'New row'}</Sheet.Title>
				<Sheet.Description class="truncate">{row ? `Version ${row.version} · updated ${when(row.updatedAt)}` : `Add a row to ${table}. Empty fields are left out.`}</Sheet.Description>
			</div>
			{#if row && (onPrev || onNext)}
				<Button variant="ghost" size="icon-sm" aria-label="Previous row" disabled={!onPrev} onclick={() => onPrev?.()}><CaretUpIcon /></Button>
				<Button variant="ghost" size="icon-sm" aria-label="Next row" disabled={!onNext} onclick={() => onNext?.()}><CaretDownIcon /></Button>
			{/if}
		</Sheet.Header>

		<Tabs.Root bind:value={tab} class="flex min-h-0 flex-1 flex-col gap-0">
			<Tabs.List variant="line" class="h-10 shrink-0 gap-4 border-b border-border px-4">
				<Tabs.Trigger value="fields">Fields</Tabs.Trigger>
				<Tabs.Trigger value="json">JSON</Tabs.Trigger>
				{#if row}<Tabs.Trigger value="details">Details</Tabs.Trigger>{/if}
			</Tabs.List>

			<div class="min-h-0 flex-1 overflow-y-auto p-4">
				{#if tab === 'fields'}
					<form
						id="record-form"
						class="flex flex-col gap-4"
						onsubmit={(e) => {
							e.preventDefault();
							void saveFields();
						}}
					>
						{#each fields as c (c.key)}
							{@const t = typeOf(c)}
							{@const d = drafts[c.key]}
							{#if d}
								<div class="flex flex-col gap-1.5">
									<label for="rec-{c.key}" class="flex items-center gap-1.5 text-sm font-medium">
										<TypeIcon type={t} class="text-muted-foreground" />
										<span class={c.kind === 'extra' ? 'italic' : ''}>{c.label}</span>
										{#if c.column?.required}<span class="text-destructive-text">*</span>{/if}
										<span class="ml-auto text-xs font-normal text-muted-foreground">{c.kind === 'extra' ? 'not in schema' : TYPE_LABELS[t]}</span>
									</label>
									{#if t === 'boolean'}
										<NativeSelect id="rec-{c.key}" bind:value={d.bool}>
											<NativeSelectOption value="">No value</NativeSelectOption>
											<NativeSelectOption value="true">Checked</NativeSelectOption>
											<NativeSelectOption value="false">Unchecked</NativeSelectOption>
										</NativeSelect>
									{:else if t === 'date'}
										<div class="flex items-center gap-2">
											<Input id="rec-{c.key}" type={d.date.mode === 'date' ? 'date' : 'datetime-local'} bind:value={d.date.value} class="flex-1" />
											<Button
												variant="ghost"
												size="sm"
												onclick={() => {
													d.date = d.date.mode === 'date' ? { mode: 'datetime', value: d.date.value ? `${d.date.value}T09:00` : '' } : { mode: 'date', value: d.date.value.slice(0, 10) };
												}}>{d.date.mode === 'date' ? 'Add time' : 'Day only'}</Button
											>
										</div>
									{:else if t === 'json'}
										<Textarea id="rec-{c.key}" bind:value={d.text} rows={3} class="font-mono text-xs" placeholder={'["a", "b"]'} spellcheck="false" />
									{:else if t === 'number'}
										<Input id="rec-{c.key}" bind:value={d.text} inputmode="decimal" placeholder={c.column?.default !== undefined ? `Default: ${c.column.default}` : ''} autocomplete="off" />
									{:else}
										<Textarea id="rec-{c.key}" bind:value={d.text} rows={d.text.length > 60 || d.text.includes('\n') ? 4 : 1} class="min-h-9 resize-y" placeholder={c.column?.default !== undefined ? `Default: ${c.column.default}` : ''} />
									{/if}
									{#if c.column?.description}<p class="text-xs text-muted-foreground">{c.column.description}</p>{/if}
								</div>
							{/if}
						{:else}
							<p class="text-sm text-muted-foreground">This table has no fields yet. Use the JSON tab to write any fields{strict ? '' : ', or add fields to the schema'}.</p>
						{/each}
					</form>
				{:else if tab === 'json'}
					<div class="flex flex-col gap-3">
						{#if jsonEditing || !row}
							<JsonEditor bind:value={jsonText} bind:valid={jsonValid} rows={16} allowEmpty={false} label="Row as JSON" onSubmit={() => void saveJson()} />
						{:else}
							<CodeBlock code={JSON.stringify(row.data, null, 2)} language={'json' as never} class="max-h-[60dvh] overflow-auto text-xs" />
							<div class="flex gap-2">
								<Button variant="outline" size="sm" onclick={() => (jsonEditing = true)}>Edit JSON</Button>
								<Button variant="ghost" size="sm" onclick={() => void copyText(JSON.stringify(row.data, null, 2)).then((ok) => ok && toast.success('Copied'))}><CopyIcon class="size-4" /> Copy</Button>
							</div>
						{/if}
						<p class="text-xs text-muted-foreground">The row's fields as a JSON object. System fields (id, times, version) are kept by the table and are not part of it.</p>
					</div>
				{:else if row}
					<dl class="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-3 text-sm">
						<dt class="text-muted-foreground">Row ID</dt>
						<dd class="flex min-w-0 items-center gap-1">
							<code class="truncate font-mono text-xs">{row.id}</code>
							<Button variant="ghost" size="icon-xs" aria-label="Copy the row ID" onclick={() => void copyText(row.id).then((ok) => ok && toast.success('Copied'))}><CopyIcon /></Button>
						</dd>
						<dt class="text-muted-foreground">Version</dt>
						<dd>{row.version} <span class="text-xs text-muted-foreground">(goes up on every change)</span></dd>
						<dt class="text-muted-foreground">Created</dt>
						<dd>{when(row.createdAt)} <span class="text-muted-foreground">by {row.createdBy}</span></dd>
						<dt class="text-muted-foreground">Last updated</dt>
						<dd>{when(row.updatedAt)} <span class="text-muted-foreground">by {row.updatedBy}</span></dd>
					</dl>
				{/if}
				{#if error}<p class="mt-4 rounded-lg border border-destructive/40 bg-destructive-soft p-3 text-sm text-destructive-text" role="alert">{error}</p>{/if}
			</div>
		</Tabs.Root>

		<div class="flex shrink-0 items-center gap-2 border-t border-border p-3">
			{#if row}
				<Button variant="ghost" size="sm" class="text-destructive-text hover:bg-destructive-soft" onclick={() => (confirmDelete = true)}><TrashIcon class="size-4" /> Delete</Button>
			{/if}
			<span class="flex-1"></span>
			{#if tab === 'json' && (jsonEditing || !row)}
				{#if row}<Button variant="ghost" size="sm" onclick={() => init(row)}>Cancel</Button>{/if}
				<Button size="sm" disabled={busy || !jsonValid} onclick={() => void saveJson()}>{#if busy}<Spinner />{/if}{row ? 'Save JSON' : 'Add row'}</Button>
			{:else if tab === 'fields'}
				<Button variant="ghost" size="sm" onclick={() => (open = false)}>Close</Button>
				<Button size="sm" type="submit" form="record-form" disabled={busy}>{#if busy}<Spinner />{/if}{row ? 'Save changes' : 'Add row'}</Button>
			{:else}
				<Button variant="ghost" size="sm" onclick={() => (open = false)}>Close</Button>
			{/if}
		</div>
	</Sheet.Content>
</Sheet.Root>

<ConfirmAction bind:open={confirmDelete} title="Delete this row?" description="The row is removed from {table}. This cannot be undone." confirmLabel="Delete row" onConfirm={remove} />
