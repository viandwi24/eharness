<script lang="ts">
	import PauseIcon from 'phosphor-svelte/lib/Pause';
	import { Button } from '#lib/components/ui/button/index.js';
	import { formatDateTime } from '#lib/time.js';
	import { pauseStore } from '#lib/stores/pause.svelte.js';
	import ResumeDialog from './ResumeDialog.svelte';

	/** Not dismissable: shown on every page while the workspace is paused. */
	let resumeOpen = $state(false);
	const view = $derived(pauseStore.view);
</script>

{#if view?.paused && view.pausedAt !== null}
	<div role="status" data-testid="pause-banner" class="flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-warning-soft px-3 py-1.5 text-xs text-warning-text">
		<PauseIcon class="size-3.5 shrink-0" weight="fill" />
		<span>
			Paused since {formatDateTime(view.pausedAt)}{#if view.note} · {view.note}{/if} · {view.skippedWhilePaused} scheduled {view.skippedWhilePaused === 1 ? 'run' : 'runs'} skipped so far
		</span>
		<Button size="sm" variant="outline" class="h-6 px-2 text-xs" onclick={() => (resumeOpen = true)}>Resume</Button>
	</div>
	<ResumeDialog bind:open={resumeOpen} />
{/if}
