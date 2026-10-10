<script lang="ts">
	import { CommandEmpty } from "#lib/components/ui/command/index.js";
	import type { ComponentProps } from "svelte";

	let { ref = $bindable(null), children, ...restProps }: ComponentProps<typeof CommandEmpty> = $props();
</script>

<CommandEmpty bind:ref {...restProps}>
	{@render children?.()}
</CommandEmpty>
