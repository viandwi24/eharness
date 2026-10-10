<script lang="ts">
	import CircleIcon from 'phosphor-svelte/lib/Circle';
	import SpinnerIcon from 'phosphor-svelte/lib/Spinner';
	import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircle';
	import WarningCircleIcon from 'phosphor-svelte/lib/WarningCircle';
	import { cn } from "#lib/utils.js";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		class: className,
		status,
		children,
		...restProps
	}: HTMLAttributes<HTMLDivElement> & {
		/** ✦ Leading status icon: pending, in-progress (spinner), completed (struck through), error. */
		status?: "pending" | "in-progress" | "completed" | "error";
	} = $props();
</script>

{#if status}
	<div
		data-slot="ai-task-item"
		data-status={status}
		class={cn(
			"flex items-start gap-2 text-[13.5px] [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0",
			(status === "completed" || status === "pending") && "text-muted-foreground",
			status === "error" && "text-destructive-text",
			className
		)}
		{...restProps}
	>
		{#if status === "pending"}
			<CircleIcon class="text-muted-foreground-2" />
		{:else if status === "in-progress"}
			<SpinnerIcon class="animate-spin text-info-text" />
		{:else if status === "completed"}
			<CheckCircleIcon class="text-success-text" />
		{:else}
			<WarningCircleIcon class="text-destructive-text" />
		{/if}
		<!-- Inline flow: the line-through reaches the text but not the inline-flex file chips. -->
		<span class={cn("min-w-0", status === "completed" && "line-through")}>
			{@render children?.()}
		</span>
	</div>
{:else}
	<div data-slot="ai-task-item" class={cn("text-[13.5px] text-muted-foreground", className)} {...restProps}>
		{@render children?.()}
	</div>
{/if}
