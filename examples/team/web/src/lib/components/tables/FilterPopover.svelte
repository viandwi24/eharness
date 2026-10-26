<script lang="ts" module>
	import type { Condition, Match } from '#lib/tables/filters.js';
	/** What the filter editor holds: plain-word conditions, or a raw filter typed as JSON. */
	export type FilterState = { mode: 'builder' | 'json'; match: Match; conditions: Condition[]; json: string };
	export const noFilter = (): FilterState => ({ mode: 'builder', match: 'and', conditions: [], json: '' });
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import FunnelSimpleIcon from 'phosphor-svelte/lib/FunnelSimple';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import XIcon from 'phosphor-svelte/lib/X';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import * as Tabs from '#lib/components/ui/tabs/index.js';
	import { blankCondition, conditionsFilter, filterConditions, opsFor, retype, takesValue } from '#lib/tables/filters.js';
	import type { GridColumn } from '#lib/tables/grid.js';
	import { type ColumnType, type Filter, parseJsonFilter } from '#lib/tables/tables.js';
	import JsonEditor from './JsonEditor.svelte';

	let {
		open = $bindable(false),
		value,
		fields,
		addField = $bindable(null),
		onApply
	}: {
		open?: boolean;
		value: FilterState;
		fields: GridColumn[];
		/** Set by a column menu: open with a new condition on this field. */
		addField?: string | null;
		onApply: (state: FilterState, filter: Filter | undefined) => void;
	} = $props();

	let draft = $state<FilterState>({ mode: 'builder', match: 'and', conditions: [], json: '' });
	let jsonValid = $state(true);
	let error = $state('');

	const types = $derived(Object.fromEntries(fields.map((f) => [f.field, f.type])) as Record<string, ColumnType>);
	const typeOf = (field: string): ColumnType => types[field] ?? 'string';
	const active = $derived(value.mode === 'json' ? (value.json.trim() ? 1 : 0) : value.conditions.length);

	$effect(() => {
		if (!open) return;
		untrack(() => {
			draft = structuredClone($state.snapshot(value)) as FilterState;
			error = '';
			if (addField) {
				draft.mode = 'builder';
				draft.conditions = [...draft.conditions, blankCondition(addField, typeOf(addField))];
				addField = null;
			} else if (draft.mode === 'builder' && draft.conditions.length === 0 && fields[0]) draft.conditions = [blankCondition(fields[0].field, fields[0].type)];
		});
	});

	function switchMode(mode: string): void {
		error = '';
		if (mode === 'json' && draft.mode === 'builder') {
			const f = conditionsFilter(draft.conditions, types, draft.match);
			draft.json = f.ok && f.filter ? JSON.stringify(f.filter, null, 2) : draft.json;
		} else if (mode === 'builder' && draft.mode === 'json') {
			const j = parseJsonFilter(draft.json);
			const back = j.ok ? filterConditions(j.filter) : null;
			if (!back) {
				error = 'This filter is too complex for the simple editor. Keep editing it as JSON, or clear it.';
				return;
			}
			draft.match = back.match;
			draft.conditions = back.conditions.length ? back.conditions : fields[0] ? [blankCondition(fields[0].field, fields[0].type)] : [];
		}
		draft.mode = mode as FilterState['mode'];
	}

	function apply(): void {
		error = '';
		if (draft.mode === 'json') {
			const j = parseJsonFilter(draft.json);
			if (!j.ok) {
				error = j.error;
				return;
			}
			onApply({ ...draft, conditions: [] }, j.filter);
		} else {
			const conds = draft.conditions.filter((c) => c.field);
			const f = conditionsFilter(conds, types, draft.match);
			if (!f.ok) {
				error = f.error;
				return;
			}
			onApply({ ...draft, conditions: conds, json: '' }, f.filter);
		}
		open = false;
	}

	function clear(): void {
		onApply({ mode: 'builder', match: 'and', conditions: [], json: '' }, undefined);
		open = false;
	}

	const labelOf = (field: string): string => fields.find((f) => f.field === field)?.label ?? field;
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant={active ? 'secondary' : 'outline'} size="sm" aria-label="Filter rows">
				<FunnelSimpleIcon />Filter
				{#if active > 0}<Badge shape="number" variant="brand" class="h-4 min-w-4 px-1 text-[10px]">{active}</Badge>{/if}
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content elevation="floating" align="start" class="flex max-h-[80dvh] w-[min(calc(100vw-1.5rem),36rem)] flex-col gap-3 overflow-y-auto p-3">
		<form
			class="flex flex-col gap-3"
			onsubmit={(e) => {
				e.preventDefault();
				apply();
			}}
		>
			<Tabs.Root value={draft.mode} onValueChange={switchMode}>
				<Tabs.List variant="line" class="h-8 gap-3">
					<Tabs.Trigger value="builder">Conditions</Tabs.Trigger>
					<Tabs.Trigger value="json">Advanced (JSON)</Tabs.Trigger>
				</Tabs.List>
			</Tabs.Root>

			{#if draft.mode === 'builder'}
				{#if draft.conditions.length > 1}
					<div class="flex items-center gap-2 text-xs text-muted-foreground">
						Show rows that match
						<NativeSelect bind:value={draft.match} size="sm" aria-label="Match" class="w-24">
							<NativeSelectOption value="and">all</NativeSelectOption>
							<NativeSelectOption value="or">any</NativeSelectOption>
						</NativeSelect>
						of these conditions
					</div>
				{/if}
				{#if !draft.conditions.length}
					<p class="text-xs text-muted-foreground">No conditions: every row shows.</p>
				{/if}
				{#each draft.conditions as c, i (i)}
					{@const t = typeOf(c.field)}
					<div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-1.5 sm:grid-cols-[9rem_9rem_minmax(0,1fr)_auto]">
						<NativeSelect value={c.field} size="sm" aria-label="Field" class="w-full" onchange={(e) => (draft.conditions[i] = retype({ ...c, field: e.currentTarget.value }, typeOf(e.currentTarget.value)))}>
							{#each fields as f (f.key)}<NativeSelectOption value={f.field}>{f.label}</NativeSelectOption>{/each}
						</NativeSelect>
						<NativeSelect bind:value={c.op} size="sm" aria-label="Condition" class="w-full">
							{#each opsFor(t) as o (o.id)}<NativeSelectOption value={o.id}>{o.label}</NativeSelectOption>{/each}
						</NativeSelect>
						<div class="order-last col-span-3 sm:order-none sm:col-span-1">
							{#if !takesValue(c.op)}
								<span class="block h-8"></span>
							{:else if t === 'date'}
								<Input type="date" bind:value={c.value} aria-label="Day" class="h-8 text-xs" />
							{:else}
								<Input
									bind:value={c.value}
									inputmode={t === 'number' ? 'decimal' : undefined}
									placeholder={c.op === 'anyOf' || c.op === 'noneOf' ? 'a, b, c' : t === 'number' ? '0' : 'value'}
									aria-label="Value"
									class="h-8 text-xs"
									autocomplete="off"
								/>
							{/if}
						</div>
						<Button variant="ghost" size="icon-sm" aria-label="Remove condition on {labelOf(c.field)}" onclick={() => (draft.conditions = draft.conditions.filter((_, j) => j !== i))}><XIcon class="size-4" /></Button>
					</div>
				{/each}
				<div>
					<Button
						variant="ghost"
						size="sm"
						class="-ml-2"
						disabled={!fields.length}
						onclick={() => {
							const f = fields[0];
							if (f) draft.conditions = [...draft.conditions, blankCondition(f.field, f.type)];
						}}><PlusIcon class="size-4" /> Add condition</Button
					>
				</div>
			{:else}
				<JsonEditor bind:value={draft.json} bind:valid={jsonValid} rows={7} label="Filter as JSON" onSubmit={apply} />
				<p class="text-xs leading-relaxed text-muted-foreground">
					A MongoDB-style filter, e.g. <code class="font-mono">{'{ "$or": [{ "vip": true }, { "points": { "$gte": 10 } }] }'}</code>. Operators: $eq $ne $gt $gte $lt $lte $in $nin $contains $startsWith $exists $has $and $or $not.
				</p>
			{/if}

			{#if error}<p class="text-xs text-destructive-text" role="alert">{error}</p>{/if}
			<div class="flex items-center justify-end gap-2 border-t border-border pt-3">
				<Button variant="ghost" size="sm" class="mr-auto" disabled={active === 0} onclick={clear}>Clear filter</Button>
				<Button variant="ghost" size="sm" onclick={() => (open = false)}>Cancel</Button>
				<Button type="submit" size="sm" disabled={draft.mode === 'json' && !jsonValid}>Apply</Button>
			</div>
		</form>
	</Popover.Content>
</Popover.Root>
