<script lang="ts">
	import PauseIcon from 'phosphor-svelte/lib/Pause';
	import PlayIcon from 'phosphor-svelte/lib/Play';
	import * as Tooltip from '#lib/components/ui/tooltip/index.js';
	import { pauseStore } from '#lib/stores/pause.svelte.js';
	import { cn } from '#lib/utils.js';
	import PauseDialog from './PauseDialog.svelte';
	import ResumeDialog from './ResumeDialog.svelte';

	/** The always-reachable control of the rail: "Pause all", and "Paused" while it is on. `bar`: the mobile tab bar. */
	let { bar = false }: { bar?: boolean } = $props();

	let pauseOpen = $state(false);
	let resumeOpen = $state(false);
	const paused = $derived(pauseStore.view?.paused === true);
	const label = $derived(paused ? 'Paused: resume' : 'Pause all');
</script>

<Tooltip.Root>
	<Tooltip.Trigger>
		{#snippet child({ props })}
			<button
				{...props}
				type="button"
				aria-label={label}
				data-testid="pause-button"
				onclick={() => (paused ? (resumeOpen = true) : (pauseOpen = true))}
				class={cn(
					'relative flex items-center justify-center rounded-xl text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
					bar ? 'h-11 min-w-16 flex-1 flex-col gap-0.5 rounded-lg text-[10px]' : 'size-10',
					paused && 'bg-warning-soft text-warning-text hover:bg-warning-soft hover:text-warning-text'
				)}
			>
				{#if paused}<PlayIcon class="size-5" weight="fill" />{:else}<PauseIcon class="size-5" />{/if}
				{#if bar}<span>{paused ? 'Paused' : 'Pause all'}</span>{/if}
			</button>
		{/snippet}
	</Tooltip.Trigger>
	{#if !bar}<Tooltip.Content side="right">{paused ? 'Paused · click to resume' : 'Pause all'}</Tooltip.Content>{/if}
</Tooltip.Root>
<PauseDialog bind:open={pauseOpen} />
<ResumeDialog bind:open={resumeOpen} />
