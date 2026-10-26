<script lang="ts">
	// A list of short texts as chips: type and press Enter (or comma) to add, × to remove.
	// Suggestions (e.g. chat titles) show as a list under the input and as quick-add chips.
	import XIcon from 'phosphor-svelte/lib/X';
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import { cn } from '#lib/utils.js';
	import type { Option } from '#lib/scripts/lookups.svelte.js';

	let {
		values = $bindable([]),
		placeholder = 'Type and press Enter',
		suggestions = [],
		id,
		label,
		mono = false,
		class: className = ''
	}: {
		values?: string[];
		placeholder?: string;
		suggestions?: Option[];
		id?: string;
		label: string;
		mono?: boolean;
		class?: string;
	} = $props();

	let draft = $state('');
	let focused = $state(false);
	const listId = $derived(id ? `${id}-list` : undefined);
	const unused = $derived(suggestions.filter((s) => !values.includes(s.value)));
	const labelOf = (v: string): string => suggestions.find((s) => s.value === v)?.label ?? v;

	function add(raw: string): void {
		const v = raw.trim();
		if (!v || values.includes(v)) {
			draft = '';
			return;
		}
		values = [...values, v];
		draft = '';
	}
	function remove(v: string): void {
		values = values.filter((x) => x !== v);
	}
	function onKey(e: KeyboardEvent): void {
		if (e.key === 'Enter' || e.key === ',') {
			e.preventDefault();
			add(draft);
		} else if (e.key === 'Backspace' && draft === '' && values.length) {
			values = values.slice(0, -1);
		}
	}
</script>

<div class={cn('flex flex-col gap-1.5', className)}>
	<div
		class={cn(
			'flex min-h-9 flex-wrap items-center gap-1 rounded-md border border-input bg-transparent px-1.5 py-1 text-sm shadow-xs transition-[color,box-shadow] dark:bg-input/30',
			focused && 'border-ring ring-[3px] ring-ring/50'
		)}
	>
		{#each values as v (v)}
			<span class={cn('inline-flex max-w-full items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs', mono && 'font-mono')}>
				<span class="truncate" title={v}>{labelOf(v)}</span>
				<button type="button" class="rounded text-muted-foreground hover:text-foreground" aria-label="Remove {labelOf(v)}" onclick={() => remove(v)}><XIcon class="size-3" /></button>
			</span>
		{/each}
		<input
			{id}
			class={cn('h-6 min-w-24 flex-1 bg-transparent px-1 outline-none placeholder:text-muted-foreground', mono && 'font-mono text-xs')}
			aria-label={label}
			list={listId}
			{placeholder}
			bind:value={draft}
			onkeydown={onKey}
			onfocus={() => (focused = true)}
			onblur={() => {
				focused = false;
				if (draft.trim()) add(draft);
			}}
			autocomplete="off"
		/>
		{#if listId}
			<datalist id={listId}>
				{#each unused as s (s.value)}<option value={s.value}>{s.hint ? `${s.label} · ${s.hint}` : s.label}</option>{/each}
			</datalist>
		{/if}
	</div>
	{#if unused.length && unused.length <= 12}
		<div class="flex flex-wrap gap-1">
			{#each unused as s (s.value)}
				<button type="button" class="inline-flex items-center gap-0.5 rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground hover:border-solid hover:text-foreground" onclick={() => add(s.value)} title={s.hint}>
					<PlusIcon class="size-3" />{s.label}
				</button>
			{/each}
		</div>
	{/if}
</div>
