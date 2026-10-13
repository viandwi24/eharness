<script lang="ts">
	import ToolPart from '#lib/parts/ToolPart.svelte';
	import type { ToolView } from '#lib/parts/activity.js';
	import type { ApprovalStanding } from '#lib/approval/chip.js';
	import ArtifactChatCard from './ArtifactChatCard.svelte';

	/**
	 * `artifact_create`: a shimmering card while the agent writes it (title and kind from the streamed
	 * input). Once it is done the `data-artifact` card takes over; without one (or on failure) the
	 * ordinary tool row says what happened.
	 */
	let {
		view,
		hasCard,
		standing,
		onFocusDock
	}: { view: ToolView; hasCard: boolean; standing?: (id: string) => ApprovalStanding; onFocusDock?: (id: string) => void } = $props();

	const input = $derived((view.input ?? {}) as { title?: unknown; kind?: unknown });
	const writing = $derived(view.state === 'input-streaming' || view.state === 'input-available');
</script>

{#if writing}
	<ArtifactChatCard generating kind={typeof input.kind === 'string' ? input.kind : 'file'} title={typeof input.title === 'string' && input.title ? input.title : 'New artifact'} />
{:else if !(view.state === 'output-available' && hasCard)}
	<ToolPart {view} {standing} {onFocusDock} />
{/if}
