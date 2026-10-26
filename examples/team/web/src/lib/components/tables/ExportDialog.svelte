<script lang="ts">
	import { untrack } from 'svelte';
	import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircle';
	import DownloadSimpleIcon from 'phosphor-svelte/lib/DownloadSimple';
	import { api, fetchLibraryBlob } from '#lib/api/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import type { SortRule } from '#lib/tables/filters.js';
	import { defaultExportPath, type FileFormat, filesHref, type Filter, idsFilter, withFormat } from '#lib/tables/tables.js';
	import { cn } from '#lib/utils.js';

	/** Write rows (all, the current view, or the selected ones) to a library file, then download it. */
	let {
		open = $bindable(false),
		table,
		filter,
		sort,
		selected = [],
		total,
		start = 'all'
	}: {
		open?: boolean;
		table: string;
		filter: Filter | undefined;
		sort: SortRule[] | undefined;
		selected?: string[];
		/** Rows in the current view. */
		total: number;
		start?: 'all' | 'view' | 'selected';
	} = $props();

	const FORMATS: { id: FileFormat; label: string; hint: string }[] = [
		{ id: 'csv', label: 'CSV', hint: 'Spreadsheets (Excel, Sheets)' },
		{ id: 'json', label: 'JSON', hint: 'A list of objects' },
		{ id: 'ndjson', label: 'NDJSON', hint: 'One object per line' }
	];

	let format = $state<FileFormat>('csv');
	let scope = $state<'all' | 'view' | 'selected'>('all');
	let path = $state('');
	let error = $state('');
	let busy = $state(false);
	let result = $state<{ path: string; rows: number } | null>(null);
	const hasView = $derived(!!filter || !!sort);

	$effect(() => {
		if (open)
			untrack(() => {
				format = 'csv';
				scope = start === 'selected' && selected.length ? 'selected' : start === 'view' && hasView ? 'view' : 'all';
				path = defaultExportPath(table);
				error = '';
				result = null;
			});
	});

	function pickFormat(f: FileFormat): void {
		format = f;
		path = withFormat(path, f);
	}

	async function submit(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		error = '';
		busy = true;
		try {
			const f = scope === 'selected' ? idsFilter(selected) : scope === 'view' ? filter : undefined;
			result = await api.post('/tables/{table}/export', { params: { table }, body: { path: path.trim(), format, ...(f ? { filter: f } : {}), ...(scope !== 'all' && sort ? { sort } : {}) } });
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not export the rows';
		} finally {
			busy = false;
		}
	}

	async function download(): Promise<void> {
		if (!result) return;
		try {
			const blob = await fetchLibraryBlob(result.path);
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = result.path.split('/').pop() ?? 'export';
			a.click();
			setTimeout(() => URL.revokeObjectURL(url), 1000);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not download the file';
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content elevation="floating" class="[&>*]:min-w-0 max-h-[92dvh] overflow-y-auto sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Export rows</Dialog.Title>
			<Dialog.Description>Saves a file to the library that you can download or hand to an agent.</Dialog.Description>
		</Dialog.Header>
		{#if result}
			<div class="flex flex-col items-center gap-2 rounded-lg border border-border p-6 text-center" role="status">
				<CheckCircleIcon class="size-8 text-success-text" weight="fill" />
				<p class="text-sm"><strong>{result.rows.toLocaleString()}</strong> row{result.rows === 1 ? '' : 's'} saved to</p>
				<a class="font-mono text-xs underline underline-offset-4" href={filesHref(result.path)}>{result.path}</a>
			</div>
			{#if error}<p class="text-sm text-destructive-text" role="alert">{error}</p>{/if}
			<Dialog.Footer>
				<Button variant="ghost" onclick={() => (open = false)}>Close</Button>
				<Button variant="outline" onclick={() => void download()}><DownloadSimpleIcon class="size-4" /> Download</Button>
			</Dialog.Footer>
		{:else}
			<form class="flex flex-col gap-4" onsubmit={submit}>
				<div class="flex flex-col gap-2">
					<span class="text-sm font-medium">Format</span>
					<div class="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Format">
						{#each FORMATS as f (f.id)}
							<button
								type="button"
								role="radio"
								aria-checked={format === f.id}
								class={cn('flex flex-col items-start rounded-lg border px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring', format === f.id ? 'border-brand bg-brand-soft' : 'border-border hover:bg-accent')}
								onclick={() => pickFormat(f.id)}
							>
								<span class="text-sm font-medium">{f.label}</span>
								<span class="text-[11px] leading-tight text-muted-foreground">{f.hint}</span>
							</button>
						{/each}
					</div>
				</div>
				<div class="flex flex-col gap-2">
					<span class="text-sm font-medium">Rows</span>
					<div class="flex flex-col gap-1" role="radiogroup" aria-label="Rows">
						{#each [{ id: 'all', label: 'All rows', on: true }, { id: 'view', label: `Rows in the current view (${total.toLocaleString()}) — filter, search and sort`, on: hasView }, { id: 'selected', label: `Selected rows (${selected.length})`, on: selected.length > 0 }] as o (o.id)}
							<label class="flex items-center gap-2 rounded-md px-1 py-1 text-sm {o.on ? '' : 'text-muted-foreground opacity-60'}">
								<input type="radio" name="export-scope" value={o.id} bind:group={scope} disabled={!o.on} class="accent-[var(--brand)]" />
								{o.label}
							</label>
						{/each}
					</div>
				</div>
				<Field.Field>
					<Field.Label for="export-path">Save as</Field.Label>
					<Input id="export-path" bind:value={path} class="font-mono text-xs" autocomplete="off" required />
					<Field.Description>A path in the library. An existing file there is replaced.</Field.Description>
				</Field.Field>
				{#if error}<p class="text-sm text-destructive-text" role="alert">{error}</p>{/if}
				<Dialog.Footer>
					<Button type="button" variant="ghost" onclick={() => (open = false)}>Cancel</Button>
					<Button type="submit" disabled={busy || !path.trim()}>{#if busy}<Spinner />{/if}Export</Button>
				</Dialog.Footer>
			</form>
		{/if}
	</Dialog.Content>
</Dialog.Root>
