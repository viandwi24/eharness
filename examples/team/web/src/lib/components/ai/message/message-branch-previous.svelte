<script lang="ts">
	import CaretLeftIcon from 'phosphor-svelte/lib/CaretLeft';
	import { Button, type ButtonProps } from "#lib/components/ui/button/index.js";
	import { useMessageBranch } from "./use-message.svelte.js";

	let { children, ...restProps }: Omit<ButtonProps, "href" | "onclick"> = $props();

	const branches = useMessageBranch();
</script>

<Button
	aria-label="Previous branch"
	disabled={branches.totalBranches <= 1}
	onclick={() => branches.goToPrevious()}
	size="icon-xs"
	type="button"
	variant="ghost"
	{...restProps}
>
	{#if children}
		{@render children()}
	{:else}
		<CaretLeftIcon  />
	{/if}
</Button>
