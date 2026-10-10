<script lang="ts">
	import CaretRightIcon from 'phosphor-svelte/lib/CaretRight';
	import { Button, type ButtonProps } from "#lib/components/ui/button/index.js";
	import { getEmblaContext } from "#lib/components/ui/carousel/context.js";

	let { children, ...restProps }: Omit<ButtonProps, "href" | "onclick"> = $props();

	const embla = getEmblaContext("<InlineCitationCarouselNext/>");
</script>

<Button
	type="button"
	variant="ghost"
	size="icon-xs"
	aria-label="Next"
	onclick={() => embla.scrollNext()}
	{...restProps}
>
	{#if children}
		{@render children()}
	{:else}
		<CaretRightIcon  />
	{/if}
</Button>
