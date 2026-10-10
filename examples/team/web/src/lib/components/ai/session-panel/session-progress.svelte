<script lang="ts">
	import CaretRightIcon from 'phosphor-svelte/lib/CaretRight';
	import XIcon from 'phosphor-svelte/lib/X';
	import { Button } from "#lib/components/ui/button/index.js";
	import * as Collapsible from "#lib/components/ui/collapsible/index.js";
	import { Progress } from "#lib/components/ui/progress/index.js";
	import { cn } from "#lib/utils.js";
	import type { Snippet } from "svelte";

	let {
		title = "Progress",
		value,
		onClose,
		defaultOpen = false,
		open = $bindable(defaultOpen),
		class: className,
		children,
	}: {
		title?: string;
		/** 0 to 100: shows a progress bar above the content. */
		value?: number;
		/** Shows the close button. */
		onClose?: () => void;
		defaultOpen?: boolean;
		open?: boolean;
		class?: string;
		children?: Snippet;
	} = $props();
</script>

<!-- Collapsible "Progress" section with the panel close button. -->
<Collapsible.Root data-slot="ai-session-progress" bind:open class={cn("w-full", className)}>
	<div class="flex items-center justify-between">
		<Collapsible.Trigger
			class="group/trigger flex items-center gap-1 text-sm outline-none focus-visible:underline"
		>
			{title}
			<CaretRightIcon class="size-3.5 text-muted-foreground transition-transform group-data-[state=open]/trigger:rotate-90" />
		</Collapsible.Trigger>
		{#if onClose}
			<Button aria-label="Close" onclick={onClose} size="icon-xs" type="button" variant="ghost">
				<XIcon class="size-3.5" />
			</Button>
		{/if}
	</div>
	<Collapsible.Content class="pt-3 text-[13px] text-muted-foreground">
		{#if value !== undefined}
			<Progress {value} class="mb-3" />
		{/if}
		{@render children?.()}
	</Collapsible.Content>
</Collapsible.Root>
