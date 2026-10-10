<script lang="ts">
	import { CommandEmpty } from "#lib/components/ui/command/index.js";
	import type { ComponentProps } from "svelte";

	let { children, ...restProps }: ComponentProps<typeof CommandEmpty> = $props();
</script>

<CommandEmpty {...restProps}>
	{#if children}
		{@render children()}
	{:else}
		No microphone found.
	{/if}
</CommandEmpty>
