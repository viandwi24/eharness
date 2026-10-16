<script lang="ts">
	import CaretRightIcon from 'phosphor-svelte/lib/CaretRight';
	import { Shimmer } from '#lib/components/ai/shimmer/index.js';
	import { ToolInput, ToolOutput } from '#lib/components/ai/tool/index.js';
	import { cn } from '#lib/utils.js';
	import { isRunning, type ToolView, toolNote } from './activity.js';
	import { approvalChip, type ApprovalStanding } from '#lib/approval/chip.js';
	import { getChatEnv } from '#lib/artifacts/context.js';
	import MediaRefImage from './MediaRefImage.svelte';
	import { toolImages } from './media.js';

	/** `nested`: a row inside a ToolGroup box (padded, no own indent). */
	let {
		view,
		nested = false,
		standing,
		onFocusDock
	}: { view: ToolView; nested?: boolean; standing?: (approvalId: string) => ApprovalStanding; onFocusDock?: (approvalId: string) => void } = $props();

	let open = $state(false);
	const env = getChatEnv();
	let loadingFull = $state(false);
	async function loadFull(): Promise<void> {
		loadingFull = true;
		try {
			if (view.messageId) await env?.loadFull?.(view.messageId);
		} finally {
			loadingFull = false;
		}
	}
	const hasInput = $derived(view.input !== undefined && view.input !== null);
	const hasOutput = $derived(view.output !== undefined && view.output !== null && view.output !== '');
	const running = $derived(isRunning(view));
	// images the tool stored for the person (a browser screenshot, an MCP screenshot) are shown right away
	const pictures = $derived(toolImages(view.output));
	// A call that needed an approval says where it stands; the approval itself is in the dock.
	const chip = $derived(approvalChip(view, view.approval ? standing?.(view.approval.id) : undefined));
	const note = $derived(chip?.kind === 'declined' ? undefined : toolNote(view));
	const chipTone = {
		waiting: 'text-warning-text',
		approved: 'text-success-text',
		declined: 'text-muted-foreground',
		elsewhere: 'text-muted-foreground',
		answered: 'text-muted-foreground'
	} as const;
</script>

<!-- One quiet row (Claude Code style); the parameters and the result open below it. -->
<div class={cn(nested && 'px-3 py-2')}>
	<div class="flex max-w-full flex-wrap items-center gap-x-1">
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
	{#if chip}
		{#if chip.kind === 'waiting' && onFocusDock}
			<button type="button" class={cn('ml-1.5 text-[12.5px] underline underline-offset-4', chipTone.waiting)} data-testid="approval-chip" onclick={() => view.approval && onFocusDock(view.approval.id)}>{chip.text}</button>
		{:else}
			<span class={cn('ml-1.5 text-[12.5px]', chipTone[chip.kind])} data-testid="approval-chip">{chip.text}{#if chip.kind === 'declined' && chip.note}<span class="text-muted-foreground"> ({chip.note})</span>{/if}</span>
		{/if}
	{/if}
	</div>
	{#if pictures.length > 0 && !open}
		<div class="mt-2 mb-1 flex flex-col gap-2">
			{#each pictures as picture (picture.path)}<MediaRefImage path={picture.path} />{/each}
		</div>
	{/if}
	{#if open}
		<div class="mt-2 mb-1 flex flex-col gap-3">
			{#if hasInput}<ToolInput input={view.input} />{/if}
			{#if hasOutput || view.errorText}
				<ToolOutput output={view.output} errorText={view.errorText} />
				{#if view.clipped && env?.loadFull}
					<button type="button" class="self-start text-[12.5px] text-muted-foreground underline underline-offset-4 hover:text-foreground" disabled={loadingFull} onclick={() => void loadFull()}>
						{loadingFull ? 'Loading…' : 'Load full output'}
					</button>
				{/if}
			{:else if !hasInput}
				<p class="text-[13px] text-muted-foreground">No details yet.</p>
			{/if}
		</div>
	{/if}
</div>
