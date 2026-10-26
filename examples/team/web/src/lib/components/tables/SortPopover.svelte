<script lang="ts">
	import ArrowsDownUpIcon from 'phosphor-svelte/lib/ArrowsDownUp';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import XIcon from 'phosphor-svelte/lib/X';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import { MAX_SORTS, type SortRule } from '#lib/tables/filters.js';
	import type { GridColumn } from '#lib/tables/grid.js';
	import type { ColumnType } from '#lib/tables/tables.js';

	/** Sort rules (at most 3), applied as you change them. Without rules rows come oldest first. */
	let { open = $bindable(false), rules, fields, onChange }: { open?: boolean; rules: SortRule[]; fields: GridColumn[]; onChange: (rules: SortRule[]) => void } = $props();

	const typeOf = (field: string): ColumnType => fields.find((f) => f.field === field)?.type ?? 'string';
	const words = (t: ColumnType): [string, string] => (t === 'number' ? ['1 → 9', '9 → 1'] : t === 'date' ? ['Oldest first', 'Newest first'] : t === 'boolean' ? ['Unchecked first', 'Checked first'] : ['A → Z', 'Z → A']);

	function update(i: number, patch: Partial<SortRule>): void {
		const next = rules.map((r, j) => (j === i ? { ...r, ...patch } : r));
		// one rule per field
		onChange(next.filter((r, j) => next.findIndex((x) => x.field === r.field) === j));
	}
	function add(): void {
		const free = fields.find((f) => !rules.some((r) => r.field === f.field));
		if (free) onChange([...rules, { field: free.field, dir: 'asc' }]);
	}
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant={rules.length ? 'secondary' : 'outline'} size="sm" aria-label="Sort rows">
				<ArrowsDownUpIcon />Sort
				{#if rules.length}<Badge shape="number" variant="brand" class="h-4 min-w-4 px-1 text-[10px]">{rules.length}</Badge>{/if}
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content elevation="floating" align="start" class="flex w-[min(calc(100vw-1.5rem),26rem)] flex-col gap-3 p-3">
		{#if !rules.length}
			<p class="text-xs text-muted-foreground">Rows show in the order they were added. Add a sort to change it.</p>
		{/if}
		{#each rules as r, i (r.field)}
			<div class="grid grid-cols-[auto_minmax(0,1fr)_8.5rem_auto] items-center gap-1.5">
				<span class="w-10 text-xs text-muted-foreground">{i === 0 ? 'Sort by' : 'then'}</span>
				<NativeSelect value={r.field} size="sm" aria-label="Sort field" class="w-full" onchange={(e) => update(i, { field: e.currentTarget.value })}>
					{#each fields as f (f.key)}<NativeSelectOption value={f.field} disabled={f.field !== r.field && rules.some((x) => x.field === f.field)}>{f.label}</NativeSelectOption>{/each}
				</NativeSelect>
				<NativeSelect value={r.dir} size="sm" aria-label="Direction" class="w-full" onchange={(e) => update(i, { dir: e.currentTarget.value as SortRule['dir'] })}>
					<NativeSelectOption value="asc">{words(typeOf(r.field))[0]}</NativeSelectOption>
					<NativeSelectOption value="desc">{words(typeOf(r.field))[1]}</NativeSelectOption>
				</NativeSelect>
				<Button variant="ghost" size="icon-sm" aria-label="Remove sort" onclick={() => onChange(rules.filter((_, j) => j !== i))}><XIcon class="size-4" /></Button>
			</div>
		{/each}
		<div class="flex items-center justify-between">
			<Button variant="ghost" size="sm" class="-ml-2" disabled={rules.length >= MAX_SORTS || !fields.length} onclick={add}><PlusIcon class="size-4" /> Add sort</Button>
			{#if rules.length}<Button variant="ghost" size="sm" onclick={() => onChange([])}>Clear</Button>{/if}
		</div>
	</Popover.Content>
</Popover.Root>
