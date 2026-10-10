<script lang="ts">
	import * as DropdownMenu from "#lib/components/ui/dropdown-menu/index.js";
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDown';
	import { buttonVariants } from "#lib/components/ui/button/index.js";
	import { cn } from "#lib/utils.js";
	import type { ComponentProps } from "svelte";

	let { class: className, children, ...restProps }: ComponentProps<typeof DropdownMenu.Trigger> = $props();
</script>

<DropdownMenu.Trigger
	data-slot="ai-open-in-trigger"
	class={cn(buttonVariants({ variant: "outline", size: "sm" }), className)}
	{...restProps}
>
	{#if children}
		{@render children()}
	{:else}
		Open in
		<CaretDownIcon class="size-3.5" />
	{/if}
</DropdownMenu.Trigger>
