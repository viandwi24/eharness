<script lang="ts">
	import { untrack } from 'svelte';
	import TrashIcon from 'phosphor-svelte/lib/Trash';
	import { api } from '#lib/api/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { type DataTable, formatBytes, TABLE_NAME } from '#lib/tables/tables.js';

	/** A table's name and description, and the way to drop it. */
	let { open = $bindable(false), table, onSaved, onDrop }: { open?: boolean; table: DataTable; onSaved: (t: DataTable) => void; onDrop: () => void } = $props();

	let name = $state('');
	let description = $state('');
	let error = $state('');
	let busy = $state(false);

	$effect(() => {
		if (open)
			untrack(() => {
				name = table.name;
				description = table.description;
				error = '';
			});
	});

	async function submit(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		error = '';
		const n = name.trim();
		if (!TABLE_NAME.test(n)) {
			error = 'The name takes lowercase letters, digits and _, starting with a letter.';
			return;
		}
		busy = true;
		try {
			const t = await api.patch('/tables/{table}', { params: { table: table.id }, body: { ...(n !== table.name ? { name: n } : {}), description: description.trim() } });
			toast.success('Table saved');
			open = false;
			onSaved(t);
		} catch (err) {
			error = err instanceof Error ? err.message : 'Could not save the table';
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content elevation="floating" class="[&>*]:min-w-0 max-h-[92dvh] overflow-y-auto sm:max-w-lg">
		<form class="flex flex-col gap-4" onsubmit={submit}>
			<Dialog.Header>
				<Dialog.Title>Table settings</Dialog.Title>
				<Dialog.Description>Created by {table.createdBy} on {new Date(table.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}.</Dialog.Description>
			</Dialog.Header>
			<Field.Field>
				<Field.Label for="ts-name">Name</Field.Label>
				<Input id="ts-name" bind:value={name} class="font-mono text-sm" autocomplete="off" />
				{#if name.trim() !== table.name}<Field.Description>Agents and scripts that use “{table.name}” need the new name.</Field.Description>{/if}
			</Field.Field>
			<Field.Field>
				<Field.Label for="ts-desc">Description</Field.Label>
				<Textarea id="ts-desc" bind:value={description} rows={3} placeholder="What goes in this table — helps agents use it well" />
			</Field.Field>
			{#if error}<p class="text-sm text-destructive-text" role="alert">{error}</p>{/if}
			<div class="flex flex-col gap-2 rounded-lg border border-destructive/40 p-3 sm:flex-row sm:items-center">
				<div class="min-w-0 flex-1">
					<p class="text-sm font-medium">Delete this table</p>
					<p class="text-xs text-muted-foreground">Removes the table and its {table.rowCount.toLocaleString()} row{table.rowCount === 1 ? '' : 's'} ({formatBytes(table.bytes)}). Export first to keep a copy.</p>
				</div>
				<Button variant="destructive" size="sm" onclick={onDrop}><TrashIcon class="size-4" /> Delete table</Button>
			</div>
			<Dialog.Footer>
				<Button type="button" variant="ghost" onclick={() => (open = false)}>Cancel</Button>
				<Button type="submit" disabled={busy}>{#if busy}<Spinner />{/if}Save</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
