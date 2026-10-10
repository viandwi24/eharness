<script lang="ts">
	import TrashIcon from 'phosphor-svelte/lib/Trash';
	import { Button, type ButtonProps } from "#lib/components/ui/button/index.js";
	import { cn } from "#lib/utils.js";
	import { TERM_ACTION, useTerminalContext } from "./use-terminal.svelte.js";

	let {
		class: className,
		children,
		...restProps
	}: Omit<ButtonProps, "onclick" | "href"> = $props();

	const terminal = useTerminalContext();
</script>

{#if terminal.onClear}
	<Button
		aria-label="Clear output"
		class={cn(TERM_ACTION, className)}
		onclick={() => terminal.onClear?.()}
		size="icon-xs"
		type="button"
		variant="ghost"
		{...restProps}
	>
		{#if children}
			{@render children()}
		{:else}
			<TrashIcon class="size-3.5" />
		{/if}
	</Button>
{/if}
