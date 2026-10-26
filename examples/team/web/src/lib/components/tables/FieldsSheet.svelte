<script lang="ts">
	import ArrowDownIcon from 'phosphor-svelte/lib/ArrowDown';
	import ArrowUpIcon from 'phosphor-svelte/lib/ArrowUp';
	import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimple';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import TrashIcon from 'phosphor-svelte/lib/Trash';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Sheet from '#lib/components/ui/sheet/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { TYPE_LABELS } from '#lib/tables/grid.js';
	import type { TableColumn, TableSchema } from '#lib/tables/tables.js';
	import TypeIcon from './TypeIcon.svelte';

	/** The schema as a list: order, edit, delete, add, and the strict switch. Every change saves. */
	let {
		open = $bindable(false),
		schema,
		extras = [],
		busy = false,
		onMove,
		onEdit,
		onDelete,
		onAdd,
		onAddExtra,
		onStrict
	}: {
		open?: boolean;
		schema: TableSchema;
		/** Fields seen in rows that the schema lacks. */
		extras?: string[];
		busy?: boolean;
		onMove: (index: number, delta: -1 | 1) => void;
		onEdit: (col: TableColumn) => void;
		onDelete: (col: TableColumn) => void;
		onAdd: () => void;
		onAddExtra: (name: string) => void;
		onStrict: (on: boolean) => void;
	} = $props();

	const show = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));
</script>

<Sheet.Root bind:open>
	<Sheet.Content side="right" class="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-md">
		<Sheet.Header class="border-b border-border pb-4">
			<Sheet.Title>Fields</Sheet.Title>
			<Sheet.Description>The shape of a row. Changes apply to new writes; existing rows are not rewritten.</Sheet.Description>
		</Sheet.Header>
		<div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
			{#if schema.columns.length}
				<ol class="flex flex-col gap-1.5">
					{#each schema.columns as c, i (c.name)}
						<li class="group flex items-start gap-2.5 rounded-lg border border-border bg-card p-2.5">
							<span class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"><TypeIcon type={c.type} class="size-4" /></span>
							<div class="min-w-0 flex-1">
								<div class="flex flex-wrap items-center gap-1.5">
									<span class="truncate text-sm font-medium">{c.name}</span>
									<span class="text-xs text-muted-foreground">{TYPE_LABELS[c.type]}</span>
									{#if c.required}<Badge variant="warning" class="h-4 px-1.5 text-[10px]">required</Badge>{/if}
									{#if c.indexed}<Badge variant="info" class="h-4 px-1.5 text-[10px]">indexed</Badge>{/if}
								</div>
								{#if c.description}<p class="line-clamp-2 text-xs text-muted-foreground">{c.description}</p>{/if}
								{#if c.default !== undefined}<p class="truncate text-xs text-muted-foreground">Default: <span class="font-mono">{show(c.default)}</span></p>{/if}
							</div>
							<div class="flex shrink-0 items-center">
								<Button variant="ghost" size="icon-xs" aria-label="Move {c.name} up" disabled={busy || i === 0} onclick={() => onMove(i, -1)}><ArrowUpIcon /></Button>
								<Button variant="ghost" size="icon-xs" aria-label="Move {c.name} down" disabled={busy || i === schema.columns.length - 1} onclick={() => onMove(i, 1)}><ArrowDownIcon /></Button>
								<Button variant="ghost" size="icon-xs" aria-label="Edit {c.name}" disabled={busy} onclick={() => onEdit(c)}><PencilSimpleIcon /></Button>
								<Button variant="ghost" size="icon-xs" aria-label="Delete {c.name}" disabled={busy} onclick={() => onDelete(c)}><TrashIcon /></Button>
							</div>
						</li>
					{/each}
				</ol>
			{:else}
				<p class="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">No fields yet: rows may hold anything.</p>
			{/if}
			<Button variant="outline" size="sm" class="self-start" disabled={busy} onclick={onAdd}><PlusIcon class="size-4" /> Add field</Button>

			{#if extras.length}
				<div class="flex flex-col gap-2">
					<p class="text-xs text-muted-foreground">Seen in rows but not in the schema:</p>
					<div class="flex flex-wrap gap-1.5">
						{#each extras as name (name)}
							<button type="button" class="inline-flex items-center gap-1 rounded-md border border-dashed border-border px-2 py-0.5 text-xs italic hover:bg-accent" disabled={busy} title="Add to the schema" onclick={() => onAddExtra(name)}>
								<PlusIcon class="size-3" />{name}
							</button>
						{/each}
					</div>
				</div>
			{/if}

			<label class="mt-auto flex items-start justify-between gap-4 rounded-lg border border-border p-3">
				<span class="flex flex-col gap-0.5">
					<span class="text-sm font-medium">Only allow these fields</span>
					<span class="text-xs text-muted-foreground">When on, rows with any other field are refused, so typos can't sneak in. Rows already stored are not changed.</span>
				</span>
				<Switch checked={schema.strict === true} disabled={busy} onCheckedChange={(v) => onStrict(v === true)} />
			</label>
		</div>
	</Sheet.Content>
</Sheet.Root>
