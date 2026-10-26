<script lang="ts">
	import { api } from '#lib/api/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { defaultExportPath, filesHref, type Filter } from '#lib/tables/tables.js';

	/** Write a table's rows (all, or the grid's filter and sort) to a library file. */
	let {
		open = $bindable(false),
		table,
		filter,
		sort
	}: { open?: boolean; table: string; filter: Filter | undefined; sort: Record<string, 1 | -1> | undefined } = $props();

	let path = $state('');
	let format = $state<'' | 'csv' | 'json' | 'ndjson'>('');
	let useView = $state(true);
	let error = $state('');
	let busy = $state(false);
	let result = $state<{ path: string; rows: number } | null>(null);
	const hasView = $derived(!!filter || !!sort);

	$effect(() => {
		if (open) {
			path = defaultExportPath(table);
			error = '';
			result = null;
		}
	});

	async function submit(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		error = '';
		result = null;
		busy = true;
		try {
			result = await api.post('/tables/{table}/export', {
				params: { table },
				body: { path: path.trim(), ...(format ? { format } : {}), ...(useView && filter ? { filter } : {}), ...(useView && sort ? { sort } : {}) }
			});
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not export the rows';
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content elevation="floating" class="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
		<form class="flex flex-col gap-4" onsubmit={submit}>
			<Dialog.Header>
				<Dialog.Title>Export rows</Dialog.Title>
				<Dialog.Description>Writes the rows to a library file. A CSV starts with the _id column and imports back.</Dialog.Description>
			</Dialog.Header>
			<Field.Field data-invalid={!!error}>
				<Field.Label for="export-path">Library file</Field.Label>
				<Input id="export-path" bind:value={path} class="font-mono text-xs" autocomplete="off" required />
			</Field.Field>
			<Field.Field>
				<Field.Label for="export-format">Format</Field.Label>
				<NativeSelect id="export-format" bind:value={format}>
					<NativeSelectOption value="">From the extension</NativeSelectOption>
					<NativeSelectOption value="csv">CSV</NativeSelectOption>
					<NativeSelectOption value="json">JSON array</NativeSelectOption>
					<NativeSelectOption value="ndjson">NDJSON</NativeSelectOption>
				</NativeSelect>
			</Field.Field>
			<label class="flex items-center gap-2 text-sm {hasView ? '' : 'text-muted-foreground'}">
				<Checkbox checked={useView && hasView} disabled={!hasView} onCheckedChange={(v) => (useView = v === true)} />
				Use the current filter and sort{hasView ? '' : ' (none set: all rows)'}
			</label>
			{#if error}<p class="text-sm text-destructive-text" role="alert">{error}</p>{/if}
			{#if result}
				<p class="rounded-lg border border-border p-3 text-sm" role="status">
					<strong>{result.rows.toLocaleString()}</strong> row{result.rows === 1 ? '' : 's'} written to
					<a class="font-mono text-xs underline underline-offset-4" href={filesHref(result.path)}>{result.path}</a>
				</p>
			{/if}
			<Dialog.Footer>
				<Button type="button" variant="ghost" onclick={() => (open = false)}>{result ? 'Close' : 'Cancel'}</Button>
				<Button type="submit" disabled={busy || !path.trim()}>Export</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
