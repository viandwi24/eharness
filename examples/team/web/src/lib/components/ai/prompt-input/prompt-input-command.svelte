<script lang="ts">
	import { Command } from "#lib/components/ui/command/index.js";
	import type { ComponentProps } from "svelte";

	let { ref = $bindable(null), children, ...restProps }: ComponentProps<typeof Command> = $props();
</script>

<Command bind:ref {...restProps}>
	{@render children?.()}
</Command>
