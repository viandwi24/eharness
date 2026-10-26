<script lang="ts">
	import FunnelIcon from 'phosphor-svelte/lib/Funnel';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import XIcon from 'phosphor-svelte/lib/X';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Collapsible from '#lib/components/ui/collapsible/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { buildFilter, type ColumnType, combineFilters, type Condition, FILTER_OPS, type Filter, parseJsonFilter, takesValue } from '#lib/tables/tables.js';

	/**
	 * The filter of the grid: conditions combined with AND, plus a raw filter object. `onApply`
	 * gets the combined filter (undefined for none) and the number of active parts.
	 */
	let {
		fields,
		types,
		active = 0,
		conditions = $bindable([]),
		json = $bindable(''),
		onApply
	}: {
		fields: string[];
		types: Record<string, ColumnType>;
		active?: number;
		conditions?: Condition[];
		json?: string;
		onApply: (filter: Filter | undefined, count: number) => void;
	} = $props();

	let open = $state(false);
	let advanced = $state(false);
	let error = $state('');

	const blank = (): Condition => ({ field: fields[0] ?? '', op: 'eq', value: '' });

	$effect(() => {
		if (open && conditions.length === 0 && !json) conditions = [blank()];
	});

	function apply(): void {
		error = '';
		const b = buildFilter(conditions, types);
		if (!b.ok) {
			error = b.error;
			return;
		}
		const j = parseJsonFilter(json);
		if (!j.ok) {
			error = j.error;
			return;
		}
		const count = conditions.filter((c) => c.field.trim()).length + (j.filter ? 1 : 0);
		onApply(combineFilters(b.filter, j.filter), count);
		open = false;
	}

	function clear(): void {
		conditions = [];
		json = '';
		error = '';
		onApply(undefined, 0);
		open = false;
	}
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="outline" size="sm" aria-label="Filter rows">
				<FunnelIcon /><span class="hidden sm:inline">Filter</span>
				{#if active > 0}<Badge shape="number" variant="brand" class="h-4 min-w-4 px-1 text-[10px]">{active}</Badge>{/if}
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content elevation="floating" align="start" class="flex max-h-[80vh] w-[min(94vw,34rem)] flex-col gap-3 overflow-y-auto p-3">
		<form
			class="flex flex-col gap-3"
			onsubmit={(e) => {
				e.preventDefault();
				apply();
			}}
		>
			<p class="text-xs text-muted-foreground">Rows matching every condition.</p>
			<datalist id="table-filter-fields">
				{#each fields as f (f)}<option value={f}></option>{/each}
			</datalist>
			{#each conditions as c, i (i)}
				<div class="grid grid-cols-[minmax(0,1fr)_7.5rem_auto] items-center gap-1.5 sm:grid-cols-[minmax(0,1fr)_7.5rem_minmax(0,1fr)_auto]">
					<Input bind:value={c.field} list="table-filter-fields" placeholder="field" aria-label="Field" class="h-8 font-mono text-xs" autocomplete="off" />
					<NativeSelect bind:value={c.op} size="sm" aria-label="Operator" class="w-30">
						{#each FILTER_OPS as o (o.id)}<NativeSelectOption value={o.id}>{o.label}</NativeSelectOption>{/each}
					</NativeSelect>
					<Input bind:value={c.value} disabled={!takesValue(c.op)} placeholder={takesValue(c.op) ? 'value' : ''} aria-label="Value" class="order-last col-span-3 h-8 text-xs sm:order-none sm:col-span-1" autocomplete="off" />
					<Button variant="ghost" size="icon-sm" aria-label="Remove condition" onclick={() => (conditions = conditions.filter((_, j) => j !== i))}><XIcon class="size-4" /></Button>
				</div>
			{/each}
			<div>
				<Button variant="ghost" size="sm" onclick={() => (conditions = [...conditions, blank()])}><PlusIcon class="size-4" /> Add condition</Button>
			</div>
			<Collapsible.Root bind:open={advanced}>
				<Collapsible.Trigger class="text-xs text-muted-foreground underline-offset-4 hover:underline">{advanced ? 'Hide' : 'Advanced (JSON)'}</Collapsible.Trigger>
				<Collapsible.Content class="mt-2 flex flex-col gap-1">
					<Textarea bind:value={json} rows={4} class="font-mono text-xs" placeholder={'{ "$or": [{ "vip": true }, { "points": { "$gte": 10 } }] }'} aria-label="Filter as JSON" />
					<span class="text-xs text-muted-foreground">A filter object with $eq $ne $gt $gte $lt $lte $in $nin $contains $startsWith $exists $has $and $or $not. Combined with the conditions above.</span>
				</Collapsible.Content>
			</Collapsible.Root>
			{#if error}<p class="text-xs text-destructive-text" role="alert">{error}</p>{/if}
			<div class="flex justify-end gap-2">
				<Button variant="ghost" size="sm" disabled={active === 0 && conditions.every((c) => !c.field) && !json} onclick={clear}>Clear</Button>
				<Button type="submit" size="sm">Apply</Button>
			</div>
		</form>
	</Popover.Content>
</Popover.Root>
