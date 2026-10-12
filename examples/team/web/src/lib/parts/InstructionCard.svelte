<script lang="ts">
	import CaretRightIcon from 'phosphor-svelte/lib/CaretRight';
	import SafeStreamdown from './SafeStreamdown.svelte';
	import { cn } from '#lib/utils.js';
	import { unwrapText } from './unwrap.js';

	/** A turn the system wrote for the agent (task, program or rehearsal prompt): collapsed until opened. */
	let { text }: { text: string } = $props();
	let open = $state(false);
	const body = $derived(unwrapText(text));
	const preview = $derived(body.replace(/\s+/g, ' ').trim().slice(0, 90));
</script>

<div class="w-full max-w-full rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm" data-testid="instruction-card">
	<button type="button" class="flex w-full items-center gap-1.5 text-left text-[13px] text-muted-foreground hover:text-foreground" aria-expanded={open} onclick={() => (open = !open)}>
		<CaretRightIcon class={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
		<span class="font-medium text-foreground">Instructions</span>
		{#if !open}<span class="min-w-0 truncate">{preview}</span>{/if}
	</button>
	{#if open}
		<div class="mt-2 max-h-96 overflow-auto text-[13.5px] leading-[1.6] [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap">
			<SafeStreamdown content={body} baseTheme="shadcn" />
		</div>
	{/if}
</div>
