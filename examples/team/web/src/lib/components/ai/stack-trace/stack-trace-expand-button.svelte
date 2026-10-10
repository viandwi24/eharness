<script lang="ts">
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDown';
	import { cn } from "#lib/utils.js";
	import { useStackTraceContext } from "./use-stack-trace.svelte.js";

	let { class: className }: { class?: string } = $props();

	const stack = useStackTraceContext();
</script>

<div data-slot="ai-stack-trace-expand" class={cn("flex size-6 items-center justify-center", className)}>
	<CaretDownIcon class={cn("size-3.5 text-muted-foreground transition-transform", stack.open ? "rotate-180" : "rotate-0")} />
</div>
