<script lang="ts">
	import { cn } from "#lib/utils.js";
	import { BIG_OUTPUT, previewText, sizeLabel } from "#lib/parts/big.js";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		class: className,
		input,
		...restProps
	}: HTMLAttributes<HTMLDivElement> & { input: unknown } = $props();

	const formatted = $derived(JSON.stringify(input, null, 2) ?? "");
	let showAll = $state(false);
	const preview = $derived(previewText(formatted, BIG_OUTPUT));
</script>

<div data-slot="ai-tool-input" class={cn("overflow-hidden", className)} {...restProps}>
	<div class="mb-1.5 font-mono text-[11px] font-medium tracking-[0.8px] text-muted-foreground uppercase">
		Parameters
	</div>
	<pre
		class="m-0 overflow-x-auto rounded-lg bg-muted px-3 py-2.5 font-mono text-xs leading-[1.6] whitespace-pre text-foreground">{showAll ? formatted : preview.shown}</pre>
	{#if preview.big && !showAll}
		<button type="button" class="mt-1.5 text-[12.5px] text-muted-foreground underline underline-offset-4 hover:text-foreground" onclick={() => (showAll = true)}>
			Show all ({sizeLabel(formatted.length)})
		</button>
	{/if}
</div>
