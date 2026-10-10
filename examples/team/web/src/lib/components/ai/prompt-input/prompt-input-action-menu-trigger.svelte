<script lang="ts">
	import PlusIcon from 'phosphor-svelte/lib/Plus';
	import { DropdownMenuTrigger } from "#lib/components/ui/dropdown-menu/index.js";
	import type { ComponentProps } from "svelte";
	import PromptInputButton from "./prompt-input-button.svelte";

	let {
		class: className,
		children,
		...restProps
	}: Omit<ComponentProps<typeof PromptInputButton>, "tooltip"> = $props();
</script>

<DropdownMenuTrigger>
	{#snippet child({ props })}
		<PromptInputButton {...props} class={className} {...restProps}>
			{#if children}
				{@render children()}
			{:else}
				<PlusIcon class="size-4" />
			{/if}
		</PromptInputButton>
	{/snippet}
</DropdownMenuTrigger>
