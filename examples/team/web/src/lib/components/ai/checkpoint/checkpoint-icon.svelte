<script lang="ts">
	import BookmarkIcon from 'phosphor-svelte/lib/Bookmark';
	import { cn } from "#lib/utils.js";
	import type { HTMLAttributes } from "svelte/elements";

	let { class: className, children, ...restProps }: HTMLAttributes<HTMLSpanElement> = $props();
</script>

<span data-slot="ai-checkpoint-icon" class={cn("inline-flex shrink-0 [&_svg]:size-4", className)} {...restProps}>
	{#if children}
		{@render children()}
	{:else}
		<BookmarkIcon  />
	{/if}
</span>
