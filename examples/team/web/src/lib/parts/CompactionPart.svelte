<script lang="ts">
	import CaretRightIcon from 'phosphor-svelte/lib/CaretRight';
	import { cn } from '#lib/utils.js';

	/** The `eh.compaction` marker: a divider that says what was summarized; click shows the summary. */
	let { summary, tokens, trigger }: { summary: string; tokens?: unknown; trigger?: string } = $props();
	let open = $state(false);

	const fmt = (n: number): string => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));
	const t = $derived(
		tokens && typeof tokens === 'object' && typeof (tokens as { before?: unknown }).before === 'number'
			? (tokens as { before: number; after: number })
			: undefined
	);
	const how = $derived(trigger === 'manual' ? 'Compacted on request' : 'Compacted automatically');
</script>

<div class="w-full text-xs text-muted-foreground">
	<button
		type="button"
		class="flex w-full items-center gap-3 hover:text-foreground"
		aria-expanded={open}
		onclick={() => (open = !open)}
	>
		<span class="h-px flex-1 bg-border"></span>
		<span class="flex items-center gap-1.5">
			{how}{#if t}<span class="tabular-nums">· {fmt(t.before)} → {fmt(t.after)} tokens</span>{/if}
			<CaretRightIcon class={cn('size-3 transition-transform', open && 'rotate-90')} />
		</span>
		<span class="h-px flex-1 bg-border"></span>
	</button>
	{#if open}
		<div class="mt-3 rounded-lg border border-border bg-muted/40 p-3 text-left text-[13px] leading-relaxed whitespace-pre-wrap text-foreground-2">
			<p class="mb-2 text-xs font-medium text-muted-foreground">Summary the agent continues from</p>
			{summary}
		</div>
	{/if}
</div>
