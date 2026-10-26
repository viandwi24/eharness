<script lang="ts">
	import { untrack } from 'svelte';
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlass';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import TableIcon from 'phosphor-svelte/lib/Table';
	import { api } from '#lib/api/index.js';
	import { live } from '#lib/stores/live.svelte.js';
	import PageBody from '#lib/components/app/PageBody.svelte';
	import PageHeader from '#lib/components/app/PageHeader.svelte';
	import Surface from '#lib/components/app/Surface.svelte';
	import NewTableDialog from '#lib/components/tables/NewTableDialog.svelte';
	import TypeIcon from '#lib/components/tables/TypeIcon.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Empty from '#lib/components/ui/empty/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Skeleton } from '#lib/components/ui/skeleton/index.js';
	import { relativeTime } from '#lib/routines/schedule.js';
	import { formatBytes, type DataTable } from '#lib/tables/tables.js';

	let tables = $state<DataTable[] | null>(null);
	let error = $state('');
	let query = $state('');
	let order = $state<'updated' | 'name' | 'rows'>('updated');
	let creating = $state(false);
	let seq = 0;

	async function load(): Promise<void> {
		const mine = ++seq;
		try {
			const r = await api.get('/tables');
			if (mine !== seq) return;
			tables = r.tables;
			error = '';
		} catch (e) {
			if (mine === seq) error = e instanceof Error ? e.message : 'Could not load the tables';
		}
	}

	// first load, and a refetch when an agent, a script or another tab changes a table
	$effect(() => {
		void live.state.revs.tables;
		untrack(() => void load());
	});

	const shown = $derived.by(() => {
		const q = query.trim().toLowerCase();
		const list = (tables ?? []).filter((t) => !q || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || t.schema.columns.some((c) => c.name.toLowerCase().includes(q)));
		const by = { updated: (a: DataTable, b: DataTable) => b.updatedAt - a.updatedAt, name: (a: DataTable, b: DataTable) => a.name.localeCompare(b.name), rows: (a: DataTable, b: DataTable) => b.rowCount - a.rowCount }[order];
		return [...list].sort(by);
	});

	const plural = (n: number, word: string): string => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
	<PageHeader title="Tables" description="Lists and records you and your agents keep together.">
		<Button size="sm" onclick={() => (creating = true)}><PlusIcon class="size-4" /> New table</Button>
	</PageHeader>

	<PageBody size="wide">
		{#if error}
			<Surface class="flex items-center justify-between gap-3 border-destructive/40 p-4 text-sm" role="alert">
				<span class="text-destructive-text">{error}</span>
				<Button size="sm" variant="outline" onclick={() => void load()}>Try again</Button>
			</Surface>
		{:else if !tables}
			<Skeleton class="h-9 w-72" />
			<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
				{#each [0, 1, 2] as i (i)}<Skeleton class="h-36 w-full rounded-xl" />{/each}
			</div>
		{:else if !tables.length}
			<Empty.Root class="border border-dashed border-border py-16">
				<Empty.Header>
					<Empty.Media variant="icon"><TableIcon /></Empty.Media>
					<Empty.Title>No tables yet</Empty.Title>
					<Empty.Description>A table keeps rows of data like a spreadsheet: contacts, tasks, orders, a daily log. You edit it here; agents and scripts read and update it too.</Empty.Description>
				</Empty.Header>
				<Empty.Content>
					<Button onclick={() => (creating = true)}><PlusIcon class="size-4" /> Create your first table</Button>
				</Empty.Content>
			</Empty.Root>
		{:else}
			<div class="flex flex-wrap items-center gap-2">
				<InputGroup.Root class="h-8 w-full sm:w-72">
					<InputGroup.Addon><MagnifyingGlassIcon class="size-4" /></InputGroup.Addon>
					<InputGroup.Input bind:value={query} placeholder="Search tables" aria-label="Search tables" />
				</InputGroup.Root>
				<span class="flex-1"></span>
				<span class="text-xs text-muted-foreground">{plural(tables.length, 'table')}</span>
				<NativeSelect bind:value={order} size="sm" aria-label="Sort tables" class="w-40">
					<NativeSelectOption value="updated">Recently updated</NativeSelectOption>
					<NativeSelectOption value="name">Name</NativeSelectOption>
					<NativeSelectOption value="rows">Most rows</NativeSelectOption>
				</NativeSelect>
			</div>

			{#if shown.length === 0}
				<p class="py-10 text-center text-sm text-muted-foreground">No table matches “{query}”.</p>
			{:else}
				<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{#each shown as t (t.id)}
						<Surface as="a" href="/tables/{encodeURIComponent(t.name)}" class="group flex min-w-0 flex-col gap-3 p-4 transition-colors outline-none hover:bg-card-hi focus-visible:ring-2 focus-visible:ring-ring">
							<div class="flex min-w-0 items-start gap-3">
								<span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand-text"><TableIcon class="size-[18px]" /></span>
								<div class="min-w-0 flex-1">
									<p class="truncate text-sm font-medium group-hover:underline group-hover:underline-offset-4">{t.name}</p>
									<p class="line-clamp-2 min-h-8 text-xs leading-4 break-words text-muted-foreground">{t.description || 'No description'}</p>
								</div>
							</div>
							<div class="flex min-h-5 flex-wrap items-center gap-1">
								{#each t.schema.columns.slice(0, 4) as c (c.name)}
									<span class="inline-flex max-w-32 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"><TypeIcon type={c.type} class="size-3" /><span class="truncate">{c.name}</span></span>
								{/each}
								{#if t.schema.columns.length > 4}<span class="text-[11px] text-muted-foreground">+{t.schema.columns.length - 4}</span>{/if}
								{#if !t.schema.columns.length}<span class="text-[11px] text-muted-foreground">Any fields</span>{/if}
							</div>
							<div class="mt-auto flex items-center gap-x-3 gap-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
								<span class="font-medium text-foreground tabular-nums">{plural(t.rowCount, 'row')}</span>
								<span>{plural(t.schema.columns.length, 'field')}</span>
								<span class="tabular-nums">{formatBytes(t.bytes)}</span>
								<span class="ml-auto truncate" title="Updated {new Date(t.updatedAt).toLocaleString()} · created by {t.createdBy}">{relativeTime(t.updatedAt)}</span>
							</div>
						</Surface>
					{/each}
				</div>
			{/if}
		{/if}
	</PageBody>
</div>

<NewTableDialog bind:open={creating} taken={(tables ?? []).map((t) => t.name)} />
