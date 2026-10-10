<script lang="ts">
	import StopIcon from 'phosphor-svelte/lib/Stop';
	import XIcon from 'phosphor-svelte/lib/X';
	import ArrowUpIcon from 'phosphor-svelte/lib/ArrowUp';
	import { InputGroupButton } from "#lib/components/ui/input-group/index.js";
	import { Spinner } from "#lib/components/ui/spinner/index.js";
	import { cn } from "#lib/utils.js";
	import type { ChatStatus } from "ai";
	import type { ComponentProps } from "svelte";

	let {
		class: className,
		variant,
		size = "icon-sm",
		status,
		onStop,
		onclick,
		children,
		...restProps
	}: Omit<ComponentProps<typeof InputGroupButton>, "href" | "onclick"> & {
		status?: ChatStatus;
		/** With `onStop` the button turns into a stop button while generating. */
		onStop?: () => void;
		onclick?: (event: MouseEvent) => void;
	} = $props();

	const isGenerating = $derived(status === "submitted" || status === "streaming");
	const isStop = $derived(isGenerating && !!onStop);

	function handleClick(event: MouseEvent) {
		if (isStop) {
			event.preventDefault();
			onStop?.();
			return;
		}
		onclick?.(event);
	}
</script>

<InputGroupButton
	data-slot="ai-prompt-input-submit"
	data-status={status}
	aria-label={isGenerating ? "Stop" : "Submit"}
	type={isStop ? "button" : "submit"}
	{size}
	variant={variant ?? (status === "error" ? "destructive" : "default")}
	class={cn("rounded-[9px]", className)}
	onclick={handleClick}
	{...restProps}
>
	{#if children}
		{@render children()}
	{:else if status === "submitted"}
		<Spinner />
	{:else if status === "streaming"}
		<StopIcon class="size-3.5 fill-current" />
	{:else if status === "error"}
		<XIcon class="size-4" />
	{:else}
		<ArrowUpIcon class="size-4" />
	{/if}
</InputGroupButton>
