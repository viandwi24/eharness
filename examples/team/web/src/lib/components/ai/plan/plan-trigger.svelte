<script lang="ts">
	import CaretUpDownIcon from 'phosphor-svelte/lib/CaretUpDown';
	import { cn } from "#lib/utils.js";
	import { Button } from "#lib/components/ui/button/index.js";
	import { CollapsibleTrigger } from "#lib/components/ui/collapsible/index.js";
	import type { ComponentProps } from "svelte";

	let { class: className, children, ...restProps }: ComponentProps<typeof CollapsibleTrigger> = $props();
</script>

<CollapsibleTrigger data-slot="ai-plan-trigger" {...restProps}>
	{#snippet child({ props })}
		<Button
			{...props}
			variant="ghost"
			size="icon-sm"
			class={cn("size-8 data-[state=open]:bg-transparent hover:data-[state=open]:bg-accent", className)}
		>
			{#if children}
				{@render children()}
			{:else}
				<CaretUpDownIcon class="size-4" />
				<span class="sr-only">Toggle plan</span>
			{/if}
		</Button>
	{/snippet}
</CollapsibleTrigger>
