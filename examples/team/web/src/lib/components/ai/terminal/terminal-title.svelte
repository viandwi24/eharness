<script lang="ts">
	import TerminalIcon from 'phosphor-svelte/lib/Terminal';
	import { cn } from "#lib/utils.js";
	import type { Snippet } from "svelte";

	let { class: className, children }: { class?: string; children?: Snippet } = $props();
</script>

<div data-slot="ai-terminal-title" class={cn("flex items-center gap-2", className)}>
	<TerminalIcon class="size-3.5" />
	{#if children}{@render children()}{:else}Terminal{/if}
</div>
