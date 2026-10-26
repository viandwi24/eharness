<script lang="ts" module>
	export type ColumnAction = 'sortAsc' | 'sortDesc' | 'filter' | 'edit' | 'addToSchema' | 'hide' | 'delete';
</script>

<script lang="ts">
	import ArrowDownIcon from 'phosphor-svelte/lib/ArrowDown';
	import ArrowUpIcon from 'phosphor-svelte/lib/ArrowUp';
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDown';
	import EyeSlashIcon from 'phosphor-svelte/lib/EyeSlash';
	import FunnelSimpleIcon from 'phosphor-svelte/lib/FunnelSimple';
	import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimple';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import SortAscendingIcon from 'phosphor-svelte/lib/SortAscending';
	import SortDescendingIcon from 'phosphor-svelte/lib/SortDescending';
	import TrashIcon from 'phosphor-svelte/lib/Trash';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import { type GridColumn, TYPE_LABELS } from '#lib/tables/grid.js';
	import TypeIcon from './TypeIcon.svelte';

	/** A grid header cell: the field's icon and name; a click opens its menu. */
	let { col, sort, onAction }: { col: GridColumn; sort?: 'asc' | 'desc'; onAction: (a: ColumnAction, col: GridColumn) => void } = $props();

	const canQuery = $derived(col.field !== '' && (col.kind === 'system' || /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(col.field)));
	const words = $derived(
		col.type === 'number' ? ['1 → 9', '9 → 1'] : col.type === 'date' ? ['Oldest first', 'Newest first'] : col.type === 'boolean' ? ['Unchecked first', 'Checked first'] : ['A → Z', 'Z → A']
	);
	const tip = $derived(
		col.kind === 'system'
			? 'Kept by the table'
			: col.kind === 'extra'
				? 'Not in the schema: some rows have this field'
				: `${TYPE_LABELS[col.type]}${col.column?.required ? ' · required' : ''}${col.column?.indexed ? ' · indexed' : ''}${col.column?.description ? ` — ${col.column.description}` : ''}`
	);
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger>
		{#snippet child({ props })}
			<button
				{...props}
				type="button"
				title={tip}
				class="group/h flex h-full w-full min-w-0 items-center gap-1.5 px-2.5 text-left text-[12.5px] font-medium text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent aria-expanded:bg-accent aria-expanded:text-foreground {col.type === 'number' ? 'justify-end' : ''}"
			>
				<TypeIcon type={col.type} system={col.system} class={col.kind === 'extra' ? 'opacity-50' : ''} />
				<span class="truncate {col.kind === 'extra' ? 'italic' : ''}">{col.label}</span>
				{#if col.column?.required}<span class="text-destructive-text" aria-label="required">*</span>{/if}
				{#if sort === 'asc'}<ArrowUpIcon class="size-3 shrink-0 text-brand-text" />{:else if sort === 'desc'}<ArrowDownIcon class="size-3 shrink-0 text-brand-text" />{/if}
				<CaretDownIcon class="ml-auto size-3 shrink-0 opacity-0 group-hover/h:opacity-60 group-aria-expanded/h:opacity-60" />
			</button>
		{/snippet}
	</DropdownMenu.Trigger>
	<DropdownMenu.Content elevation="floating" align="start" class="w-56">
		<DropdownMenu.Label class="flex items-center gap-1.5 text-xs text-muted-foreground">
			<TypeIcon type={col.type} system={col.system} />
			{col.kind === 'system' ? 'System field' : col.kind === 'extra' ? 'Not in schema' : TYPE_LABELS[col.type]}
		</DropdownMenu.Label>
		{#if canQuery}
			<DropdownMenu.Item onSelect={() => onAction('sortAsc', col)}><SortAscendingIcon />Sort {words[0]}</DropdownMenu.Item>
			<DropdownMenu.Item onSelect={() => onAction('sortDesc', col)}><SortDescendingIcon />Sort {words[1]}</DropdownMenu.Item>
			<DropdownMenu.Item onSelect={() => onAction('filter', col)}><FunnelSimpleIcon />Filter by this field</DropdownMenu.Item>
			<DropdownMenu.Separator />
		{/if}
		{#if col.kind === 'schema'}
			<DropdownMenu.Item onSelect={() => onAction('edit', col)}><PencilSimpleIcon />Edit field</DropdownMenu.Item>
		{:else if col.kind === 'extra'}
			<DropdownMenu.Item onSelect={() => onAction('addToSchema', col)}><PlusIcon />Add to schema</DropdownMenu.Item>
		{/if}
		<DropdownMenu.Item onSelect={() => onAction('hide', col)}><EyeSlashIcon />Hide</DropdownMenu.Item>
		{#if col.kind === 'schema'}
			<DropdownMenu.Separator />
			<DropdownMenu.Item variant="destructive" onSelect={() => onAction('delete', col)}><TrashIcon />Delete field</DropdownMenu.Item>
		{/if}
	</DropdownMenu.Content>
</DropdownMenu.Root>
