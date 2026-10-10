<script lang="ts">
	import { CommandDialog } from "#lib/components/ui/command/index.js";
	import type { ComponentProps } from "svelte";

	let { open = $bindable(false), ...restProps }: ComponentProps<typeof CommandDialog> = $props();
</script>

<CommandDialog bind:open {...restProps} />
