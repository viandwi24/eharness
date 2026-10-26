<script lang="ts">
	import { api } from '#lib/api/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import type { TableImportResult } from '#lib/tables/tables.js';

	/** Import a library file (CSV, JSON array or NDJSON) into a table. */
	let { open = $bindable(false), table, fields, onDone }: { open?: boolean; table: string; fields: string[]; onDone: () => void } = $props();

	let path = $state('/library/data/');
	let format = $state<'' | 'csv' | 'json' | 'ndjson'>('');
	let upsertKey = $state('');
	let error = $state('');
	let busy = $state(false);
	let result = $state<TableImportResult | null>(null);

	$effect(() => {
		if (open) {
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
			result = await api.post('/tables/{table}/import', {
				params: { table },
				body: { path: path.trim(), ...(format ? { format } : {}), ...(upsertKey.trim() ? { upsertKey: upsertKey.trim() } : {}) }
			});
			onDone();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not import the file';
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content elevation="floating" class="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
		<form class="flex flex-col gap-4" onsubmit={submit}>
			<Dialog.Header>
				<Dialog.Title>Import rows</Dialog.Title>
				<Dialog.Description>Reads a library file: CSV with a header line, a JSON array of objects, or NDJSON. Bad records are skipped with a reason.</Dialog.Description>
			</Dialog.Header>
			<Field.Field data-invalid={!!error}>
				<Field.Label for="import-path">Library file</Field.Label>
				<Input id="import-path" bind:value={path} placeholder="/library/data/members.csv" class="font-mono text-xs" autocomplete="off" required />
			</Field.Field>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="import-format">Format</Field.Label>
					<NativeSelect id="import-format" bind:value={format}>
						<NativeSelectOption value="">From the extension</NativeSelectOption>
						<NativeSelectOption value="csv">CSV</NativeSelectOption>
						<NativeSelectOption value="json">JSON array</NativeSelectOption>
						<NativeSelectOption value="ndjson">NDJSON</NativeSelectOption>
					</NativeSelect>
				</Field.Field>
				<Field.Field>
					<Field.Label for="import-upsert">Update rows by (optional)</Field.Label>
					<Input id="import-upsert" bind:value={upsertKey} list="import-upsert-fields" placeholder="e.g. email" class="font-mono text-xs" autocomplete="off" />
					<datalist id="import-upsert-fields">
						{#each fields as f (f)}<option value={f}></option>{/each}
					</datalist>
				</Field.Field>
			</div>
			<p class="text-xs text-muted-foreground">With a key, a record whose value matches an existing row updates that row instead of adding one.</p>
			{#if error}<p class="text-sm text-destructive-text" role="alert">{error}</p>{/if}
			{#if result}
				<div class="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm" role="status">
					<p><strong>{result.inserted}</strong> added · <strong>{result.updated}</strong> updated · <strong>{result.skipped}</strong> skipped</p>
					{#if result.errors.length}
						<ul class="max-h-40 list-disc overflow-y-auto pl-4 text-xs text-destructive-text">
							{#each result.errors as m, i (i)}<li>{m}</li>{/each}
						</ul>
					{/if}
				</div>
			{/if}
			<Dialog.Footer>
				<Button type="button" variant="ghost" onclick={() => (open = false)}>{result ? 'Close' : 'Cancel'}</Button>
				<Button type="submit" disabled={busy || !path.trim()}>Import</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
