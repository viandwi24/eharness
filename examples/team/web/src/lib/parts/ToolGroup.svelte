<script lang="ts">
	import CaretRightIcon from 'phosphor-svelte/lib/CaretRight';
	import { Shimmer } from '#lib/components/ai/shimmer/index.js';
	import { cn } from '#lib/utils.js';
	import { groupSummary, type ToolView } from './activity.js';
	import MediaRefImage from './MediaRefImage.svelte';
	import { toolImages } from './media.js';
	import ToolPart from './ToolPart.svelte';
	import type { ApprovalStanding } from '#lib/approval/chip.js';

	let { views, standing, onFocusDock }: { views: ToolView[]; standing?: (id: string) => ApprovalStanding; onFocusDock?: (approvalId: string) => void } = $props();

	let open = $state(false);
	const summary = $derived(groupSummary(views));
	// the newest image a tool of the group stored for the person (a browser screenshot)
	const picture = $derived.by(() => {
		for (let i = views.length - 1; i >= 0; i--) {
			const images = toolImages(views[i]?.output);
			const newest = images[images.length - 1];
			if (newest) return newest.path;
		}
		return undefined;
	});
</script>

<!-- Consecutive tool calls collapse into one line ("Used 3 tools ›"); expanded, one row per call. -->
<div>
	<button
		type="button"
		class="flex max-w-full items-center gap-1.5 text-left text-[13.5px] text-muted-foreground transition-colors hover:text-foreground"
		aria-expanded={open}
		onclick={() => (open = !open)}
	>
		{#if summary.running}
			<Shimmer as="span" duration={1}>{summary.label}</Shimmer>
		{:else}
			<span class="shrink-0">{summary.label}</span>
		{/if}
		{#if summary.failed}<span class="shrink-0 text-destructive-text">· {summary.failed} failed</span>{/if}
		{#if summary.declined}<span class="shrink-0">· {summary.declined} declined</span>{/if}
		{#if !open && summary.names}<span class="truncate text-muted-foreground/70">· {summary.names}</span>{/if}
		<CaretRightIcon class={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
	</button>
	{#if picture && !open}
		<div class="mt-2 mb-1"><MediaRefImage path={picture} /></div>
	{/if}
	{#if open}
		<div class="mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border">
			{#each views as v (v.key)}
				<ToolPart view={v} nested {standing} {onFocusDock} />
			{/each}
		</div>
	{/if}
</div>
