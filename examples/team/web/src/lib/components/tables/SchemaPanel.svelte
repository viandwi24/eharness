<script lang="ts">
	import TrashIcon from 'phosphor-svelte/lib/Trash';
	import { api } from '#lib/api/index.js';
	import ConfirmDialog from '#lib/components/app/ConfirmDialog.svelte';
	import Surface from '#lib/components/app/Surface.svelte';
	import SchemaEditor from '#lib/components/tables/SchemaEditor.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { type ColumnDraft, type DataTable, draftOf, formatBytes, schemaOf, TABLE_NAME } from '#lib/tables/tables.js';

	/** Name, description and schema of a table, and dropping it. */
	let { table, onSaved, onDropped }: { table: DataTable; onSaved: (t: DataTable) => void; onDropped: () => void } = $props();

	let name = $state('');
	let description = $state('');
	let columns = $state<ColumnDraft[]>([]);
	let strict = $state(false);
	let error = $state('');
	let saving = $state(false);
	let confirmDrop = $state(false);
	let loadedVersion = -1;

	// take the table's values when it loads or changes elsewhere (not while editing the same version)
	$effect(() => {
		if (table.version === loadedVersion) return;
		loadedVersion = table.version;
		name = table.name;
		description = table.description;
		columns = table.schema.columns.map(draftOf);
		strict = table.schema.strict === true;
		error = '';
	});

	async function save(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		error = '';
		const n = name.trim();
		if (!TABLE_NAME.test(n)) {
			error = 'The name takes lowercase letters, digits and _, starting with a letter.';
			return;
		}
		const s = schemaOf(columns, strict);
		if (!s.ok) {
			error = s.errors.join('. ');
			return;
		}
		saving = true;
		try {
			const t = await api.patch('/tables/{table}', { params: { table: table.id }, body: { ...(n !== table.name ? { name: n } : {}), description: description.trim(), schema: s.schema } });
			toast.success('Table saved');
			onSaved(t);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not save the table';
		} finally {
			saving = false;
		}
	}

	async function drop(): Promise<void> {
		try {
			await api.delete('/tables/{table}', { params: { table: table.id } });
			toast.success(`Table ${table.name} dropped`);
			onDropped();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not drop the table');
		}
	}
</script>

<div class="flex max-w-3xl flex-col gap-4">
	<Surface class="p-4">
		<form class="flex flex-col gap-4" onsubmit={save}>
			<div class="grid gap-4 sm:grid-cols-[14rem_minmax(0,1fr)]">
				<Field.Field>
					<Field.Label for="table-name">Name</Field.Label>
					<Input id="table-name" bind:value={name} class="font-mono text-xs" autocomplete="off" />
				</Field.Field>
				<Field.Field>
					<Field.Label for="table-description">Description</Field.Label>
					<Input id="table-description" bind:value={description} placeholder="What the rows are, for people and agents" autocomplete="off" />
				</Field.Field>
			</div>
			<div class="flex flex-col gap-2">
				<span class="text-sm font-medium">Columns</span>
				<SchemaEditor bind:columns bind:strict idPrefix="table-schema" />
			</div>
			<p class="text-xs text-muted-foreground">Saving does not rewrite existing rows: a new type, a required column or strict mode applies to writes from then on. Renaming changes the name agents and scripts use.</p>
			{#if error}<p class="text-sm text-destructive-text" role="alert">{error}</p>{/if}
			<div class="flex justify-end">
				<Button type="submit" size="sm" disabled={saving}>Save</Button>
			</div>
		</form>
	</Surface>

	<Surface class="flex flex-col gap-3 border-destructive/40 p-4 sm:flex-row sm:items-center">
		<div class="min-w-0 flex-1">
			<p class="text-sm font-medium">Drop this table</p>
			<p class="text-xs text-muted-foreground">Deletes the table and its {table.rowCount.toLocaleString()} row{table.rowCount === 1 ? '' : 's'} ({formatBytes(table.bytes)}). Export it first to keep a copy.</p>
		</div>
		<Button variant="destructive" size="sm" onclick={() => (confirmDrop = true)}><TrashIcon class="size-4" /> Drop table</Button>
	</Surface>
</div>

<ConfirmDialog
	bind:open={confirmDrop}
	title="Drop {table.name}?"
	description="The table and all its rows are deleted. This cannot be undone, except by restoring a database backup."
	confirmLabel="Drop table"
	onConfirm={drop}
/>
