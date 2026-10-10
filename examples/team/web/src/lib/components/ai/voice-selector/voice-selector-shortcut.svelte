<script lang="ts">
	import { CommandShortcut } from "#lib/components/ui/command/index.js";
	import type { ComponentProps } from "svelte";

	let { ...restProps }: ComponentProps<typeof CommandShortcut> = $props();
</script>

<CommandShortcut {...restProps} />
