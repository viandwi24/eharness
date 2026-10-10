<script lang="ts">
	import CaretLeftIcon from 'phosphor-svelte/lib/CaretLeft';
	import { Button, type ButtonProps } from "#lib/components/ui/button/index.js";
	import { getEmblaContext } from "#lib/components/ui/carousel/context.js";

	let { children, ...restProps }: Omit<ButtonProps, "href" | "onclick"> = $props();

	const embla = getEmblaContext("<InlineCitationCarouselPrev/>");
</script>

<Button
	type="button"
	variant="ghost"
	size="icon-xs"
	aria-label="Previous"
	onclick={() => embla.scrollPrev()}
	{...restProps}
>
	{#if children}
		{@render children()}
	{:else}
		<CaretLeftIcon  />
	{/if}
</Button>
