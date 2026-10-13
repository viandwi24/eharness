<script lang="ts">
	import FileIcon from 'phosphor-svelte/lib/File';
	import ToolPart from '#lib/parts/ToolPart.svelte';
	import type { ToolView } from '#lib/parts/activity.js';
	import type { ApprovalStanding } from '#lib/approval/chip.js';
	import { openPanel } from '#lib/artifacts/open.js';
	import { isImagePath, parseSaved } from '#lib/artifacts/saved.js';
	import { basename } from '#lib/files/helpers.js';
	import Thumb from './SavedThumb.svelte';

	/** `run_python`: the ordinary tool row, plus what the run saved: image thumbnails and file chips (plan P45 R6). */
	let {
		view,
		standing,
		onFocusDock
	}: { view: ToolView; standing?: (id: string) => ApprovalStanding; onFocusDock?: (id: string) => void } = $props();

	const saved = $derived(view.state === 'output-available' ? parseSaved(view.output) : []);
	const images = $derived(saved.filter(isImagePath));
	const files = $derived(saved.filter((p) => !isImagePath(p)));
</script>

<div class="flex flex-col gap-2">
	<ToolPart {view} {standing} {onFocusDock} />
	{#if saved.length}
		<div class="flex flex-col gap-2" data-testid="run-saved">
			{#if images.length}
				<ul class="flex flex-wrap gap-2" aria-label="Saved images">
					{#each images as p (p)}<li><Thumb path={p} /></li>{/each}
				</ul>
			{/if}
			{#if files.length}
				<ul class="flex flex-wrap gap-1.5" aria-label="Saved files">
					{#each files as p (p)}
						<li>
							<button
								type="button"
								class="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1 text-xs hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring"
								title={p}
								onclick={() => openPanel({ kind: 'file', path: p })}
							>
								<FileIcon class="size-3.5 shrink-0 text-muted-foreground" /><span class="truncate">{basename(p)}</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</div>
