<script lang="ts">
	import { toast } from '#lib/components/ui/sonner/index.js';
	import { pauseStore, resumeWorkspace } from '#lib/stores/pause.svelte.js';
	import ConfirmDialog from './ConfirmDialog.svelte';

	let { open = $bindable(false) }: { open: boolean } = $props();

	async function resume(): Promise<void> {
		if (await resumeWorkspace()) toast.success('Resumed');
		else toast.error(pauseStore.error ?? 'Could not resume');
	}
</script>

<ConfirmDialog
	bind:open
	title="Resume?"
	description="Programs, routines, reminders and the heartbeat continue from their next slot. Slots skipped while paused are not replayed. Queued tasks start now, and one-time reminders that came due while paused are sent right after resume. Chat messages received while paused are not answered later."
	confirmLabel="Resume"
	confirmVariant="default"
	onConfirm={resume}
/>
