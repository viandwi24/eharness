<script lang="ts">
	import { untrack } from 'svelte';
	import CaretRightIcon from 'phosphor-svelte/lib/CaretRight';
	import JsonNode from './JsonNode.svelte';

	/** One node of the JSON tree: collapsible objects and arrays, long strings clamped. */
	let { value, name, depth = 0, openDepth = 2, last = true }: { value: unknown; name?: string | number; depth?: number; openDepth?: number; last?: boolean } = $props();

	const STR_MAX = 400;
	const ITEMS = 100;

	let open = $state(untrack(() => depth < openDepth));
	let full = $state(false);
	let shown = $state(ITEMS);

	const isArray = $derived(Array.isArray(value));
	const isObject = $derived(value !== null && typeof value === 'object');
	const entries = $derived(isObject ? (Object.entries(value as object) as [string, unknown][]) : []);
	const str = $derived(typeof value === 'string' ? value : '');
	const clipped = $derived(str.length > STR_MAX && !full);
	const comma = $derived(last ? '' : ',');
	const summary = $derived(isArray ? `[${entries.length}]` : `{${entries.length}}`);
</script>

<div class="min-w-0">
	{#if isObject && entries.length > 0}
		<button type="button" class="group inline-flex max-w-full items-center gap-1 rounded text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring" onclick={() => (open = !open)} aria-expanded={open}>
			<CaretRightIcon class="size-3 shrink-0 text-muted-foreground transition-transform {open ? 'rotate-90' : ''}" />
			{#if name !== undefined}<span class="text-info-text">{typeof name === 'number' ? name : JSON.stringify(name)}</span><span class="text-muted-foreground">:</span>{/if}
			<span class="text-muted-foreground">{isArray ? '[' : '{'}{#if !open} {summary} {isArray ? ']' : '}'}{comma}{/if}</span>
		</button>
		{#if open}
			<div class="ml-[5px] border-l border-border pl-3">
				{#each entries.slice(0, shown) as [k, v], i (k)}
					<JsonNode value={v} name={isArray ? Number(k) : k} depth={depth + 1} {openDepth} last={i === entries.length - 1} />
				{/each}
				{#if entries.length > shown}
					<button type="button" class="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" onclick={() => (shown += ITEMS)}>
						Show {Math.min(ITEMS, entries.length - shown)} more ({entries.length - shown} hidden)
					</button>
				{/if}
			</div>
			<span class="text-muted-foreground">{isArray ? ']' : '}'}{comma}</span>
		{/if}
	{:else}
		<div class="flex min-w-0 gap-1 pl-4">
			{#if name !== undefined}<span class="shrink-0 text-info-text">{typeof name === 'number' ? name : JSON.stringify(name)}</span><span class="shrink-0 text-muted-foreground">:</span>{/if}
			<span class="min-w-0 break-words whitespace-pre-wrap">
				{#if isObject}
					<span class="text-muted-foreground">{isArray ? '[]' : '{}'}</span>
				{:else if typeof value === 'string'}
					<span class="text-success-text">"{clipped ? str.slice(0, STR_MAX) : str}{clipped ? '…' : ''}"</span>
					{#if str.length > STR_MAX}
						<button type="button" class="ml-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" onclick={() => (full = !full)}>
							{full ? 'less' : `${str.length - STR_MAX} more chars`}
						</button>
					{/if}
				{:else if typeof value === 'number'}
					<span class="text-warning-text">{value}</span>
				{:else if typeof value === 'boolean'}
					<span class="text-brand-text">{value}</span>
				{:else}
					<span class="text-muted-foreground">{String(value)}</span>
				{/if}{comma}
			</span>
		</div>
	{/if}
</div>
