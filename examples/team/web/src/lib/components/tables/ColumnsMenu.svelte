<script lang="ts">
	import ColumnsIcon from 'phosphor-svelte/lib/Columns';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { type ColumnPrefs, type GridColumn, isVisible } from '#lib/tables/grid.js';
	import TypeIcon from './TypeIcon.svelte';

	/** Show or hide columns; remembered per table in this browser. */
	let { columns, prefs, onToggle, onReset }: { columns: GridColumn[]; prefs: ColumnPrefs; onToggle: (col: GridColumn, visible: boolean) => void; onReset: () => void } = $props();

	const fields = $derived(columns.filter((c) => c.kind !== 'system'));
	const system = $derived(columns.filter((c) => c.kind === 'system'));
	const hidden = $derived(fields.filter((c) => !isVisible(c, prefs)).length);
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="outline" size="sm" aria-label="Show or hide columns">
				<ColumnsIcon /><span class="hidden sm:inline">Columns</span>
				{#if hidden}<Badge shape="number" variant="secondary" class="h-4 min-w-4 px-1 text-[10px]" title="{hidden} hidden">{hidden}</Badge>{/if}
			</Button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content elevation="floating" align="end" class="max-h-[70dvh] w-60 overflow-y-auto">
		<DropdownMenu.Label class="text-xs text-muted-foreground">Fields</DropdownMenu.Label>
		{#each fields as c (c.key)}
			<DropdownMenu.CheckboxItem checked={isVisible(c, prefs)} onCheckedChange={(v) => onToggle(c, v === true)}>
				<TypeIcon type={c.type} />
				<span class="truncate {c.kind === 'extra' ? 'italic' : ''}">{c.label}</span>
				{#if c.kind === 'extra'}<span class="ml-auto text-[10px] text-muted-foreground">not in schema</span>{/if}
			</DropdownMenu.CheckboxItem>
		{:else}
			<p class="px-2 py-1.5 text-xs text-muted-foreground">No fields yet.</p>
		{/each}
		<DropdownMenu.Separator />
		<DropdownMenu.Label class="text-xs text-muted-foreground">Kept by the table</DropdownMenu.Label>
		{#each system as c (c.key)}
			<DropdownMenu.CheckboxItem checked={isVisible(c, prefs)} onCheckedChange={(v) => onToggle(c, v === true)}>
				<TypeIcon type={c.type} system={c.system} />
				{c.label}
			</DropdownMenu.CheckboxItem>
		{/each}
		<DropdownMenu.Separator />
		<DropdownMenu.Item onSelect={onReset}>Reset to default</DropdownMenu.Item>
	</DropdownMenu.Content>
</DropdownMenu.Root>
