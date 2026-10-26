<script lang="ts">
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import TrashIcon from 'phosphor-svelte/lib/Trash';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { NativeSelect, NativeSelectOption } from '#lib/components/ui/native-select/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import { COLUMN_TYPES, emptyColumn, type ColumnDraft } from '#lib/tables/tables.js';

	/** The columns of a table schema and its strict flag, edited in place. */
	let { columns = $bindable([]), strict = $bindable(false), idPrefix = 'schema' }: { columns?: ColumnDraft[]; strict?: boolean; idPrefix?: string } = $props();

	const placeholder: Record<ColumnDraft['type'], string> = { string: 'text', number: '0', boolean: 'true / false', date: '2026-10-26', json: '{"a": 1}' };
</script>

<div class="flex flex-col gap-2">
	{#if columns.length === 0}
		<p class="text-xs text-muted-foreground">No columns: every row may carry any fields. Add columns to give fields a type, a default or an index.</p>
	{:else}
		<div class="hidden grid-cols-[minmax(0,1.3fr)_7rem_minmax(0,1fr)_auto_auto_auto] items-center gap-2 px-0.5 text-xs text-muted-foreground sm:grid">
			<span>Name</span><span>Type</span><span>Default</span><span>Required</span><span>Indexed</span><span class="w-7"></span>
		</div>
	{/if}
	{#each columns as col, i (i)}
		<div class="grid grid-cols-[minmax(0,1fr)_7rem] items-center gap-2 rounded-lg border border-border p-2 sm:grid-cols-[minmax(0,1.3fr)_7rem_minmax(0,1fr)_auto_auto_auto] sm:border-0 sm:p-0.5" data-testid="schema-column">
			<Input bind:value={col.name} placeholder="column_name" aria-label="Column name" class="h-8 font-mono text-xs" autocomplete="off" />
			<NativeSelect bind:value={col.type} aria-label="Column type" size="sm" class="w-28">
				{#each COLUMN_TYPES as t (t)}<NativeSelectOption value={t}>{t}</NativeSelectOption>{/each}
			</NativeSelect>
			<Input bind:value={col.default} placeholder={`default: ${placeholder[col.type]}`} aria-label="Default value of {col.name || 'the column'}" class="col-span-2 h-8 text-xs sm:col-span-1" autocomplete="off" />
			<label class="flex items-center gap-1.5 text-xs sm:justify-center">
				<Checkbox checked={col.required} onCheckedChange={(v) => (col.required = v === true)} aria-label="Required" />
				<span class="sm:sr-only">Required</span>
			</label>
			<label class="flex items-center gap-1.5 text-xs sm:justify-center">
				<Checkbox checked={col.indexed} onCheckedChange={(v) => (col.indexed = v === true)} aria-label="Indexed" />
				<span class="sm:sr-only">Indexed</span>
			</label>
			<Button variant="ghost" size="icon-sm" aria-label="Remove column {col.name}" class="justify-self-end" onclick={() => (columns = columns.filter((_, j) => j !== i))}>
				<TrashIcon class="size-4" />
			</Button>
		</div>
	{/each}
	<div class="flex flex-wrap items-center justify-between gap-3">
		<Button variant="outline" size="sm" onclick={() => (columns = [...columns, emptyColumn()])}><PlusIcon class="size-4" /> Add column</Button>
		<label class="flex items-center gap-2 text-xs" for="{idPrefix}-strict">
			<Switch id="{idPrefix}-strict" bind:checked={strict} />
			<span>Strict: refuse fields that are not columns</span>
		</label>
	</div>
</div>
