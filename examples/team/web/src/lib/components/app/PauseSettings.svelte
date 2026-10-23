<script lang="ts">
	import * as Card from '#lib/components/ui/card/index.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { formatDateTime } from '#lib/time.js';
	import { heldText, pauseStore } from '#lib/stores/pause.svelte.js';
	import PauseDialog from './PauseDialog.svelte';
	import ResumeDialog from './ResumeDialog.svelte';

	/** Settings > General: the same controls as the rail, with the details. */
	let pauseOpen = $state(false);
	let resumeOpen = $state(false);
	const view = $derived(pauseStore.view);
</script>

<Card.Root data-testid="pause-settings">
	<Card.Header>
		<Card.Title class="flex items-center gap-2">
			Workspace activity
			{#if view?.paused}<Badge variant="warning">Paused</Badge>{:else if view}<Badge variant="outline">Running</Badge>{/if}
		</Card.Title>
		<Card.Description>
			Pause everything automatic to deploy an update or just watch without agents acting. Programs, routines, reminders, the heartbeat and queued tasks wait; your own chats, "Run now" and approvals keep working.
		</Card.Description>
	</Card.Header>
	<Card.Content class="flex flex-col gap-3 text-sm">
		{#if view?.paused && view.pausedAt !== null}
			<p>
				Paused since {formatDateTime(view.pausedAt)}{#if view.pausedBy} by {view.pausedBy}{/if}{#if view.note} · {view.note}{/if}.
				{view.skippedWhilePaused} scheduled {view.skippedWhilePaused === 1 ? 'run' : 'runs'} skipped so far; they are not replayed.
				{#if !view.holdChannels}
					Chat channels still answer.
				{:else if view.answerHeldOnResume}
					Chat channels keep messages and answer the ones that addressed the agent (up to 12 hours old) after Resume.
				{:else}
					Chat channels keep messages but do not answer them, not even after Resume.
				{/if}
			</p>
			<div><Button onclick={() => (resumeOpen = true)}>Resume</Button></div>
		{:else}
			<p class="text-muted-foreground">{view ? `Active now: ${heldText(view.held)}.` : 'Loading…'}</p>
			<div><Button variant="outline" onclick={() => (pauseOpen = true)} disabled={!view}>Pause all</Button></div>
		{/if}
	</Card.Content>
</Card.Root>
<PauseDialog bind:open={pauseOpen} />
<ResumeDialog bind:open={resumeOpen} />
