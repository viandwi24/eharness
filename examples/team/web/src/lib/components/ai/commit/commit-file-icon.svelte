<script lang="ts">
	import FileIcon from 'phosphor-svelte/lib/File';
	import { cn } from "#lib/utils.js";
	import type { SVGAttributes } from "svelte/elements";

	let { class: className, ...restProps }: SVGAttributes<SVGSVGElement> = $props();
</script>

<FileIcon class={cn("size-3.5 shrink-0 text-muted-foreground", className)} {...(restProps as object)} />
