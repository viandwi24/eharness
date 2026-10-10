<script lang="ts">
	import BookmarkIcon from 'phosphor-svelte/lib/Bookmark';
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDown';
	import { cn } from "#lib/utils.js";
	import { CollapsibleTrigger } from "#lib/components/ui/collapsible/index.js";
	import type { ComponentProps } from "svelte";

	let {
		class: className,
		count,
		children,
		...restProps
	}: ComponentProps<typeof CollapsibleTrigger> & { count: number } = $props();
</script>

<CollapsibleTrigger
	data-slot="ai-sources-trigger"
	class={cn(
		"group/sources-trigger flex w-full items-center gap-2 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
		className
	)}
	{...restProps}
>
	{#if children}
		{@render children()}
	{:else}
		<BookmarkIcon class="size-4" />
		<span>Used {count} {count === 1 ? "source" : "sources"}</span>
		<CaretDownIcon class="ml-auto size-4 transition-transform group-data-[state=open]/sources-trigger:rotate-180" />
	{/if}
</CollapsibleTrigger>
