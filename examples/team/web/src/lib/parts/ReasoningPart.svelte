<script lang="ts">
	import CaretRightIcon from 'phosphor-svelte/lib/CaretRight';
	import SafeStreamdown from './SafeStreamdown.svelte';
	import { Shimmer } from '#lib/components/ai/shimmer/index.js';
	import { cn } from '#lib/utils.js';
	import { reasoningLabel } from './activity.js';

	let { text, streaming, durationMs }: { text: string; streaming: boolean; durationMs?: number } = $props();

	// Always collapsed until the reader opens it: never auto-expand, even while streaming.
	let toggled = $state(false);
	const open = $derived(toggled);
	const label = $derived(reasoningLabel(streaming, durationMs));
	const theme = { paragraph: { base: 'my-0' } };
</script>

<div>
	<button
		type="button"
		class="flex items-center gap-1.5 text-[13.5px] text-muted-foreground transition-colors hover:text-foreground"
		aria-expanded={open}
		onclick={() => (toggled = !open)}
	>
		{#if streaming}<Shimmer as="span" duration={1}>{label}</Shimmer>{:else}<span>{label}</span>{/if}
		<CaretRightIcon class={cn('size-3.5 transition-transform', open && 'rotate-90')} />
	</button>
	{#if open && text}
		<div
			class="mt-2 border-l-2 border-border pl-3 text-[13.5px] leading-[1.6] text-muted-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
		>
			<SafeStreamdown content={text} baseTheme="shadcn" {theme} />
		</div>
	{/if}
</div>
