<script lang="ts">
	import XIcon from 'phosphor-svelte/lib/X';
	import { Button, type ButtonProps } from "#lib/components/ui/button/index.js";
	import { cn } from "#lib/utils.js";

	// Close button; a 1px divider separates it from the actions before it.
	let {
		variant = "ghost",
		size = "icon-sm",
		class: className,
		children,
		...restProps
	}: Omit<ButtonProps, "href"> = $props();
</script>

<Button
	type="button"
	{variant}
	{size}
	class={cn(
		"relative ml-2 text-muted-foreground before:absolute before:top-1/2 before:-left-1.5 before:h-[18px] before:w-px before:-translate-y-1/2 before:bg-border hover:text-foreground",
		className
	)}
	{...restProps}
>
	{#if children}
		{@render children()}
	{:else}
		<XIcon  />
	{/if}
	<span class="sr-only">Close</span>
</Button>
