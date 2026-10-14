<script lang="ts">
	import CheckIcon from 'phosphor-svelte/lib/Check';
	import CopyIcon from 'phosphor-svelte/lib/Copy';
	import { Button, type ButtonProps } from "#lib/components/ui/button/index.js";
	import { copyText } from "#lib/clipboard.js";
	import { cn } from "#lib/utils.js";
	import { onDestroy } from "svelte";
	import { useCodeBlockContext } from "./use-code-block.svelte.js";

	let {
		onCopy,
		onError,
		timeout = 2000,
		class: className,
		children,
		...restProps
	}: Omit<ButtonProps, "onclick" | "href"> & {
		onCopy?: () => void;
		onError?: (error: Error) => void;
		timeout?: number;
	} = $props();

	const block = useCodeBlockContext();
	let isCopied = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	async function copy() {
		if (!(await copyText(block.code))) {
			onError?.(new Error("Could not copy"));
			return;
		}
		isCopied = true;
		onCopy?.();
		clearTimeout(timer);
		timer = setTimeout(() => (isCopied = false), timeout);
	}

	onDestroy(() => clearTimeout(timer));
</script>

<Button
	data-slot="ai-code-block-copy"
	aria-label="Copy code"
	class={cn("shrink-0", className)}
	onclick={copy}
	size="icon-xs"
	type="button"
	variant="ghost"
	{...restProps}
>
	{#if children}
		{@render children()}
	{:else if isCopied}
		<CheckIcon  />
	{:else}
		<CopyIcon  />
	{/if}
</Button>
