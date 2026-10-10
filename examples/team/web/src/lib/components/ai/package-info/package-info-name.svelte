<script lang="ts">
	import CubeIcon from 'phosphor-svelte/lib/Cube';
	import { cn } from "#lib/utils.js";
	import type { Snippet } from "svelte";
	import type { HTMLAttributes } from "svelte/elements";
	import { usePackageInfoContext } from "./use-package-info.svelte.js";

	let {
		class: className,
		children,
		...restProps
	}: HTMLAttributes<HTMLDivElement> & { children?: Snippet } = $props();

	const info = usePackageInfoContext();
</script>

<div class={cn("flex items-center gap-2", className)} {...restProps}>
	<CubeIcon class="size-3.5 text-muted-foreground" />
	<span class="font-mono text-[13.5px] font-semibold">
		{#if children}{@render children()}{:else}{info.name}{/if}
	</span>
</div>
