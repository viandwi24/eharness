<script lang="ts">
	import ArrowDownIcon from 'phosphor-svelte/lib/ArrowDown';
	import { MessageScrollerButton } from "#lib/components/ui/message-scroller/index.js";
	import { cn } from "#lib/utils.js";
	import type { ComponentProps } from "svelte";

	// Round "scroll to latest" button; only visible when the user scrolled up.
	let {
		class: className,
		size = "icon",
		children,
		...restProps
	}: ComponentProps<typeof MessageScrollerButton> = $props();
</script>

<MessageScrollerButton
	aria-label="Scroll to latest"
	{size}
	class={cn("rounded-full", className)}
	{...restProps}
>
	{#if children}
		{@render children()}
	{:else}
		<ArrowDownIcon class="size-4" />
	{/if}
</MessageScrollerButton>
