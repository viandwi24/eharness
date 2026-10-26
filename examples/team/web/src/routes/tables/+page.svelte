<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import TableIcon from 'phosphor-svelte/lib/Table';
	import { api } from '#lib/api/index.js';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import Surface from '#lib/components/app/Surface.svelte';
	import SchemaEditor from '#lib/components/tables/SchemaEditor.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { relativeTime } from '#lib/routines/schedule.js';
	import { formatBytes, schemaOf, TABLE_NAME, type ColumnDraft, type DataTable } from '#lib/tables/tables.js';

	let tables = $state<DataTable[] | null>(null);
	let error = $state('');
	let seq = 0;

	// the "New table" dialog
	let creating = $state(false);
	let name = $state('');
	let description = $state('');
	let columns = $state<ColumnDraft[]>([]);
	let strict = $state(false);
	let nameError = $state('');
	let formError = $state('');
	let saving = $state(false);

	async function load(): Promise<void> {
		const mine = ++seq;
		try {
			const r = await api.get('/tables');
			if (mine !== seq) return;
			tables = [...r.tables].sort((a, b) => b.updatedAt - a.updatedAt);
			error = '';
		} catch (e) {
			if (mine === seq) error = e instanceof Error ? e.message : 'Could not load the tables';
		}
	}

	onMount(() => void load());

	function openCreate(): void {
		name = '';
		description = '';
		columns = [];
		strict = false;
		nameError = '';
		formError = '';
		creating = true;
	}

	async function create(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		nameError = '';
		formError = '';
		const n = name.trim();
		if (!TABLE_NAME.test(n)) {
			nameError = 'Use lowercase letters, digits and _, starting with a letter (e.g. members).';
			return;
		}
		const s = schemaOf(columns, strict);
		if (!s.ok) {
			formError = s.errors.join('. ');
			return;
		}
		saving = true;
		try {
			const t = await api.post('/tables', { body: { name: n, ...(description.trim() ? { description: description.trim() } : {}), ...(s.schema.columns.length || strict ? { schema: s.schema } : {}) } });
			creating = false;
			toast.success(`Table ${t.name} created`);
			void goto(`/tables/${encodeURIComponent(t.name)}`);
		} catch (err) {
			formError = err instanceof Error ? err.message : 'Could not create the table';
		} finally {
			saving = false;
		}
	}
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<PageHeader title="Tables" description="Structured data you and your agents keep: lists, counters, ledgers, imported records.">
		<Button size="sm" onclick={openCreate}><PlusIcon class="size-4" /> New table</Button>
	</PageHeader>

	<PageBody size="wide">
		{#if error}
			<p class="text-sm text-destructive-text" role="alert">{error} <button class="underline underline-offset-4" onclick={() => void load()}>Retry</button></p>
		{:else if !tables}
			<div class="flex flex-col gap-2">
				{#each [0, 1, 2] as i (i)}<Skeleton class="h-12 w-full" />{/each}
			</div>
		{:else if !tables.length}
			<Empty.Root class="border border-dashed border-border">
				<Empty.Header>
					<Empty.Media variant="icon"><TableIcon /></Empty.Media>
					<Empty.Title>No tables yet</Empty.Title>
					<Empty.Description>
						A table holds rows of structured data: members, orders, a reading list, daily counts. Agents query and update them with filters, and you can import or export CSV and JSON files from the library. A schema is optional.
					</Empty.Description>
				</Empty.Header>
				<Empty.Content>
					<Button onclick={openCreate}><PlusIcon class="size-4" /> New table</Button>
				</Empty.Content>
			</Empty.Root>
		{:else}
			<Surface>
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head>Table</Table.Head>
							<Table.Head data-numeric>Rows</Table.Head>
							<Table.Head class="hidden sm:table-cell" data-numeric>Size</Table.Head>
							<Table.Head class="hidden md:table-cell">Columns</Table.Head>
							<Table.Head class="hidden sm:table-cell">Updated</Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each tables as t (t.id)}
							<Table.Row class="cursor-pointer" onclick={() => void goto(`/tables/${encodeURIComponent(t.name)}`)}>
								<Table.Cell class="whitespace-normal">
									<a href="/tables/{encodeURIComponent(t.name)}" class="block font-mono text-[13px] font-medium outline-none focus-visible:underline" onclick={(e) => e.stopPropagation()}>{t.name}</a>
									{#if t.description}<div class="line-clamp-2 max-w-md text-xs break-words text-muted-foreground">{t.description}</div>{/if}
								</Table.Cell>
								<Table.Cell data-numeric>{t.rowCount.toLocaleString()}</Table.Cell>
								<Table.Cell class="hidden text-muted-foreground sm:table-cell" data-numeric>{formatBytes(t.bytes)}</Table.Cell>
								<Table.Cell class="hidden max-w-64 truncate text-xs text-muted-foreground md:table-cell" title={t.schema.columns.map((c) => `${c.name}: ${c.type}`).join(', ')}>
									{t.schema.columns.length ? t.schema.columns.map((c) => c.name).join(', ') : 'Any fields'}{t.schema.strict ? ' (strict)' : ''}
								</Table.Cell>
								<Table.Cell class="hidden text-muted-foreground sm:table-cell" title={new Date(t.updatedAt).toLocaleString()}>{relativeTime(t.updatedAt)}</Table.Cell>
							</Table.Row>
						{/each}
					</Table.Body>
				</Table.Root>
			</Surface>
		{/if}
	</PageBody>
</div>

<Dialog.Root bind:open={creating}>
	<Dialog.Content elevation="floating" class="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
		<form class="flex flex-col gap-4" onsubmit={create}>
			<Dialog.Header>
				<Dialog.Title>New table</Dialog.Title>
				<Dialog.Description>Rows are JSON documents. Columns are optional: they give fields a type, a default, a required check or an index.</Dialog.Description>
			</Dialog.Header>
			<Field.Field data-invalid={!!nameError}>
				<Field.Label for="new-table-name">Name</Field.Label>
				<Input id="new-table-name" bind:value={name} placeholder="members" class="font-mono text-xs" aria-invalid={!!nameError} autocomplete="off" />
				{#if nameError}<Field.Error>{nameError}</Field.Error>{:else}<Field.Description>Lowercase letters, digits and _, starting with a letter.</Field.Description>{/if}
			</Field.Field>
			<Field.Field>
				<Field.Label for="new-table-description">Description</Field.Label>
				<Input id="new-table-description" bind:value={description} placeholder="What the rows are, for people and agents" autocomplete="off" />
			</Field.Field>
			<div class="flex flex-col gap-2">
				<span class="text-sm font-medium">Columns</span>
				<SchemaEditor bind:columns bind:strict idPrefix="new-table" />
			</div>
			{#if formError}<p class="text-sm text-destructive-text" role="alert">{formError}</p>{/if}
			<Dialog.Footer>
				<Button type="button" variant="ghost" onclick={() => (creating = false)}>Cancel</Button>
				<Button type="submit" disabled={saving}>Create table</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
