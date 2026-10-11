<script lang="ts">
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';

	/** The app's confirmation for destructive actions (replaces the native `confirm()`). */
	let {
		open = $bindable(false),
		title,
		description,
		confirmLabel = 'Delete',
		onConfirm
	}: { open?: boolean; title: string; description: string; confirmLabel?: string; onConfirm: () => void | Promise<void> } = $props();
</script>

<AlertDialog.Root bind:open>
	<AlertDialog.Content elevation="floating">
		<AlertDialog.Header>
			<AlertDialog.Title>{title}</AlertDialog.Title>
			<AlertDialog.Description>{description}</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action variant="destructive" onclick={() => void onConfirm()}>{confirmLabel}</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
