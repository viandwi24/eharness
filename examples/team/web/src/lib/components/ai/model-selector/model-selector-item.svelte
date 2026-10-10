<script lang="ts">
	import { CommandItem } from "#lib/components/ui/command/index.js";
	import type { ComponentProps } from "svelte";

	let { ref = $bindable(null), children, ...restProps }: ComponentProps<typeof CommandItem> = $props();
</script>

<CommandItem bind:ref {...restProps}>
	{@render children?.()}
</CommandItem>
