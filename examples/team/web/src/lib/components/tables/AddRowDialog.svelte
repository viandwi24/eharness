<script lang="ts">
	import { api } from '#lib/api/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { type GridColumn, parseJsonObject, rowOf } from '#lib/tables/tables.js';

	/** Add one row: a field per known column, plus other fields as a JSON object. */
	let { open = $bindable(false), table, columns, strict = false, onDone }: { open?: boolean; table: string; columns: GridColumn[]; strict?: boolean; onDone: () => void } = $props();

	let values = $state<Record<string, string>>({});
	let extra = $state('');
	let error = $state('');
	let busy = $state(false);

	$effect(() => {
		if (open) {
			values = {};
			extra = '';
			error = '';
		}
	});

	const hint: Record<GridColumn['type'], string> = { string: 'text', number: 'number', boolean: '', date: '2026-10-26', json: 'JSON, e.g. ["a", "b"]' };

	async function submit(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		error = '';
		const r = rowOf(values, columns);
		if (!r.ok) {
			error = r.error;
			return;
		}
		const x = parseJsonObject(extra, 'Other fields');
		if (!x.ok) {
			error = x.error;
			return;
		}
		busy = true;
		try {
			await api.post('/tables/{table}/rows', { params: { table }, body: { rows: [{ ...(x.filter ?? {}), ...r.row }] } });
			open = false;
			onDone();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not add the row';
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content elevation="floating" class="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
		<form class="flex flex-col gap-4" onsubmit={submit}>
			<Dialog.Header>
				<Dialog.Title>Add a row</Dialog.Title>
				<Dialog.Description>Empty fields are left out; defaults of the schema fill them.</Dialog.Description>
			</Dialog.Header>
			{#each columns as c (c.name)}
				<Field.Field>
					<Field.Label for="add-row-{c.name}">
						<span class="font-mono text-xs">{c.name}</span>
						<span class="text-xs font-normal text-muted-foreground">{c.type}{c.column?.required ? ', required' : ''}{c.column ? '' : ', not a column'}</span>
					</Field.Label>
					{#if c.type === 'boolean'}
						<NativeSelect id="add-row-{c.name}" bind:value={values[c.name]}>
							<NativeSelectOption value="">—</NativeSelectOption>
							<NativeSelectOption value="true">true</NativeSelectOption>
							<NativeSelectOption value="false">false</NativeSelectOption>
						</NativeSelect>
					{:else}
						<Input id="add-row-{c.name}" bind:value={values[c.name]} placeholder={c.column?.default !== undefined ? `default: ${JSON.stringify(c.column.default)}` : hint[c.type]} class={c.type === 'json' ? 'font-mono text-xs' : ''} autocomplete="off" />
					{/if}
				</Field.Field>
			{/each}
			{#if !strict}
				<Field.Field>
					<Field.Label for="add-row-extra">Other fields (JSON object)</Field.Label>
					<Textarea id="add-row-extra" bind:value={extra} rows={3} class="font-mono text-xs" placeholder={'{ "note": "first contact" }'} />
				</Field.Field>
			{/if}
			{#if error}<p class="text-sm text-destructive-text" role="alert">{error}</p>{/if}
			<Dialog.Footer>
				<Button type="button" variant="ghost" onclick={() => (open = false)}>Cancel</Button>
				<Button type="submit" disabled={busy}>Add row</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
