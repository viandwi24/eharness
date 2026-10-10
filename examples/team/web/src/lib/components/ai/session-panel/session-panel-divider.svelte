<script lang="ts">
	import { Separator } from "#lib/components/ui/separator/index.js";
	import { cn } from "#lib/utils.js";
	import type { ComponentProps } from "svelte";

	let { class: className, ...restProps }: ComponentProps<typeof Separator> = $props();
</script>

<Separator class={cn("my-3", className)} {...restProps} />
