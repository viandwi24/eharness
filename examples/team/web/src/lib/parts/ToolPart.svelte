<script lang="ts">
	import CaretRightIcon from 'phosphor-svelte/lib/CaretRight';
	import { Shimmer } from '#lib/components/ai/shimmer/index.js';
	import { ToolInput, ToolOutput } from '#lib/components/ai/tool/index.js';
	import { cn } from '#lib/utils.js';
	import { isRunning, type ToolView, toolNote } from './activity.js';

	/** `nested`: a row inside a ToolGroup box (padded, no own indent). */
	let { view, nested = false }: { view: ToolView; nested?: boolean } = $props();

	let open = $state(false);
	const hasInput = $derived(view.input !== undefined && view.input !== null);
	const hasOutput = $derived(view.output !== undefined && view.output !== null && view.output !== '');
	const running = $derived(isRunning(view));
	const note = $derived(toolNote(view));
</script>

<!-- One quiet row (Claude Code style); the parameters and the result open below it. -->
<div class={cn(nested && 'px-3 py-2')}>
	<button
		type="button"
		class="group flex max-w-full items-center gap-1.5 text-left text-[13.5px] text-muted-foreground transition-colors hover:text-foreground"
		aria-expanded={open}
		onclick={() => (open = !open)}
	>
		{#if running}
			<Shimmer as="span" duration={1}>{view.title}</Shimmer>
		{:else}
			<span class="truncate">{view.title}</span>
		{/if}
		{#if note}<span class={cn('shrink-0', note.tone === 'error' && 'text-destructive-text')}>· {note.text}</span>{/if}
		<CaretRightIcon class={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
	</button>
	{#if open}
		<div class="mt-2 mb-1 flex flex-col gap-3">
			{#if hasInput}<ToolInput input={view.input} />{/if}
			{#if hasOutput || view.errorText}
				<ToolOutput output={view.output} errorText={view.errorText} />
			{:else if !hasInput}
				<p class="text-[13px] text-muted-foreground">No details yet.</p>
			{/if}
		</div>
	{/if}
</div>
