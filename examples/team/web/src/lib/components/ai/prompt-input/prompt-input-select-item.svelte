<script lang="ts">
	import { SelectItem } from "#lib/components/ui/select/index.js";
	import type { ComponentProps } from "svelte";

	let { ref = $bindable(null), ...restProps }: ComponentProps<typeof SelectItem> = $props();
</script>

<SelectItem bind:ref {...restProps} />
