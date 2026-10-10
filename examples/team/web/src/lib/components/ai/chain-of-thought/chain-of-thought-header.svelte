<script lang="ts">
	import BrainIcon from 'phosphor-svelte/lib/Brain';
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDown';
	import { cn } from "#lib/utils.js";
	import { Collapsible, CollapsibleTrigger } from "#lib/components/ui/collapsible/index.js";
	import type { ComponentProps } from "svelte";
	import { useChainOfThought } from "./use-chain-of-thought.svelte.js";

	let {
		class: className,
		children,
		...restProps
	}: ComponentProps<typeof CollapsibleTrigger> = $props();

	const cot = useChainOfThought();
</script>

<Collapsible open={cot.isOpen} onOpenChange={cot.setIsOpen}>
	<CollapsibleTrigger
		data-slot="ai-chain-of-thought-header"
		class={cn(
			"flex w-full items-center gap-2 text-[13.5px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
			className
		)}
		{...restProps}
	>
		<BrainIcon class="size-4" />
		<span class="flex-1 text-left">
			{#if children}{@render children()}{:else}Chain of thought{/if}
		</span>
		<CaretDownIcon class={cn("size-4 transition-transform", cot.isOpen ? "rotate-180" : "rotate-0")} />
	</CollapsibleTrigger>
</Collapsible>
