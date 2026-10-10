<script lang="ts">
	import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircle';
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDown';
	import { cn } from "#lib/utils.js";
	import { CollapsibleTrigger } from "#lib/components/ui/collapsible/index.js";
	import type { ComponentProps } from "svelte";

	let {
		class: className,
		title,
		children,
		...restProps
	}: Omit<ComponentProps<typeof CollapsibleTrigger>, "title"> & { title: string } = $props();
</script>

<CollapsibleTrigger
	data-slot="ai-task-trigger"
	class={cn(
		"group/task-trigger flex w-full items-center gap-2 text-[13.5px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
		className
	)}
	{...restProps}
>
	{#if children}
		{@render children()}
	{:else}
		<CheckCircleIcon class="size-4" />
		<span>{title}</span>
		<CaretDownIcon class="ml-auto size-4 transition-transform group-data-[state=open]/task-trigger:rotate-180" />
	{/if}
</CollapsibleTrigger>
