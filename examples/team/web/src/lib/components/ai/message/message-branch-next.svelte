<script lang="ts">
	import CaretRightIcon from 'phosphor-svelte/lib/CaretRight';
	import { Button, type ButtonProps } from "#lib/components/ui/button/index.js";
	import { useMessageBranch } from "./use-message.svelte.js";

	let { children, ...restProps }: Omit<ButtonProps, "href" | "onclick"> = $props();

	const branches = useMessageBranch();
</script>

<Button
	aria-label="Next branch"
	disabled={branches.totalBranches <= 1}
	onclick={() => branches.goToNext()}
	size="icon-xs"
	type="button"
	variant="ghost"
	{...restProps}
>
	{#if children}
		{@render children()}
	{:else}
		<CaretRightIcon  />
	{/if}
</Button>
